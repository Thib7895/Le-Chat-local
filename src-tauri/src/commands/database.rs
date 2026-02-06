use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// State for managing SQLite database connection
pub struct DatabaseState {
    pub conn: Mutex<Option<Connection>>,
}

impl Default for DatabaseState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

/// Conversation metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Message stored in database
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    pub images: Option<String>,    // JSON array of ImageAttachment
    pub image_gen: Option<String>, // JSON object of PersistedImageGen
}

/// Initialize the database with schema
fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        -- Enable foreign keys
        PRAGMA foreign_keys = ON;

        -- Conversations table
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT DEFAULT 'Nouvelle conversation',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Messages table
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            images TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        -- Indexes for faster queries
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
        "#,
    )?;

    // Migration: Add image_gen column if it doesn't exist
    let has_image_gen: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'image_gen'")?
        .query_row([], |row| row.get::<_, i32>(0))
        .map(|count| count > 0)
        .unwrap_or(false);

    if !has_image_gen {
        conn.execute("ALTER TABLE messages ADD COLUMN image_gen TEXT", [])?;
        eprintln!("Database: Migrated - added image_gen column");
    }

    Ok(())
}

/// Get database path in app data directory
fn get_db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure directory exists
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data.join("conversations.db"))
}

/// Initialize database connection
#[command]
pub fn db_init(app: AppHandle, state: State<DatabaseState>) -> Result<(), String> {
    let db_path = get_db_path(&app)?;
    eprintln!("Database: Initializing at {:?}", db_path);

    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    init_schema(&conn).map_err(|e| format!("Failed to initialize schema: {}", e))?;

    let mut guard = state.conn.lock().unwrap();
    *guard = Some(conn);

    eprintln!("Database: Ready");
    Ok(())
}

/// List all conversations, ordered by updated_at DESC
#[command]
pub fn list_conversations(state: State<DatabaseState>) -> Result<Vec<Conversation>, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;

    let conversations = stmt
        .query_map([], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(conversations)
}

/// Get all messages for a conversation
#[command]
pub fn get_conversation_messages(
    conversation_id: String,
    state: State<DatabaseState>,
) -> Result<Vec<DbMessage>, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, role, content, timestamp, images, image_gen
             FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
        )
        .map_err(|e| e.to_string())?;

    let messages = stmt
        .query_map([&conversation_id], |row| {
            Ok(DbMessage {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
                images: row.get(5)?,
                image_gen: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(messages)
}

/// Create a new conversation
#[command]
pub fn create_conversation(state: State<DatabaseState>) -> Result<Conversation, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, "Nouvelle conversation", now, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(Conversation {
        id,
        title: "Nouvelle conversation".to_string(),
        created_at: now,
        updated_at: now,
    })
}

/// Save a message to a conversation
#[command]
pub fn save_message(message: DbMessage, state: State<DatabaseState>) -> Result<(), String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Insert message
    conn.execute(
        "INSERT INTO messages (id, conversation_id, role, content, timestamp, images, image_gen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.id,
            message.conversation_id,
            message.role,
            message.content,
            message.timestamp,
            message.images,
            message.image_gen
        ],
    )
    .map_err(|e| e.to_string())?;

    // Update conversation's updated_at
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![now, message.conversation_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update a message content (for streaming updates)
#[command]
pub fn update_message_content(
    message_id: String,
    content: String,
    state: State<DatabaseState>,
) -> Result<(), String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    conn.execute(
        "UPDATE messages SET content = ?1 WHERE id = ?2",
        params![content, message_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update conversation title
#[command]
pub fn update_conversation_title(
    conversation_id: String,
    title: String,
    state: State<DatabaseState>,
) -> Result<(), String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    conn.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        params![title, conversation_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete a conversation and all its messages
#[command]
pub fn delete_conversation(
    conversation_id: String,
    state: State<DatabaseState>,
) -> Result<(), String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;

    // Messages will be deleted by CASCADE, but let's be explicit
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM conversations WHERE id = ?1",
        params![conversation_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Generate a title for a conversation using LLM
#[command]
pub async fn generate_conversation_title(
    app: AppHandle,
    conversation_id: String,
    user_message: String,
    assistant_message: String,
) -> Result<String, String> {
    // Get settings for Ollama URL and model
    let settings = crate::commands::get_settings(app.clone()).await?;

    // Truncate messages if too long
    let user_msg = if user_message.len() > 500 {
        format!("{}...", &user_message[..500])
    } else {
        user_message
    };
    let assistant_msg = if assistant_message.len() > 500 {
        format!("{}...", &assistant_message[..500])
    } else {
        assistant_message
    };

    let prompt = format!(
        "Generate a short title (3-5 words) for this conversation. Output ONLY the title, nothing else.\n\nUser: {}\nAssistant: {}",
        user_msg, assistant_msg
    );

    // Call Ollama with stream: false
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/chat", settings.ollama_url))
        .json(&serde_json::json!({
            "model": settings.selected_model,
            "messages": [
                {"role": "system", "content": "You are a title generator. Output only a short title (3-5 words), nothing else. No quotes, no punctuation at the end."},
                {"role": "user", "content": prompt}
            ],
            "stream": false,
            "options": {
                "temperature": 0.3,
                "num_predict": 20
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to call LLM: {}", e))?;

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let title = data["message"]["content"]
        .as_str()
        .unwrap_or("Conversation")
        .trim()
        .trim_matches('"')
        .to_string();

    // Update title in database
    let state = app.state::<DatabaseState>();
    update_conversation_title(conversation_id.clone(), title.clone(), state)?;

    // Emit event to notify frontend
    app.emit("conversation-title-updated", serde_json::json!({
        "id": conversation_id,
        "title": title
    }))
    .map_err(|e| format!("Failed to emit event: {}", e))?;

    eprintln!("Database: Generated title '{}' for conversation {}", title, conversation_id);
    Ok(title)
}
