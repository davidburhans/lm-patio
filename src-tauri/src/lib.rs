use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use std::path::PathBuf;
use std::fs;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use local_ip_address::list_afinet_netifas;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Profile {
    id: String,
    name: String,
    host: String,
    is_active: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DiscoveredHost {
    ip: String,
    name: String,
    status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GgufFileOption {
    name: String,
    size_bytes: u64,
    recommended: bool,
}

fn get_profiles_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let mut path = app.path().app_local_data_dir().unwrap_or_else(|_| {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home)
        } else if let Ok(profile) = std::env::var("USERPROFILE") {
            PathBuf::from(profile)
        } else {
            PathBuf::from(".")
        }
    });
    // Ensure the directory exists
    let _ = fs::create_dir_all(&path);
    path.push("lm_patio_profiles.json");
    path
}

fn load_profiles_from_disk(app: &tauri::AppHandle) -> Vec<Profile> {
    let path = get_profiles_path(app);
    if path.exists() {
        if let Ok(data) = fs::read_to_string(path) {
            if let Ok(profiles) = serde_json::from_str::<Vec<Profile>>(&data) {
                return profiles;
            }
        }
    }
    // Return empty by default on mobile/desktop since localhost is not running LM Studio
    Vec::new()
}

fn save_profiles_to_disk(app: &tauri::AppHandle, profiles: &[Profile]) -> Result<(), String> {
    let path = get_profiles_path(app);
    let data = serde_json::to_string_pretty(profiles)
        .map_err(|e| format!("Failed to serialize profiles: {}", e))?;
    fs::write(path, data)
        .map_err(|e| format!("Failed to write profiles to disk: {}", e))?;
    Ok(())
}

fn get_active_subnets() -> Vec<String> {
    let mut subnets = Vec::new();
    if let Ok(interfaces) = list_afinet_netifas() {
        for (_name, ip) in interfaces {
            if ip.is_ipv4() {
                let ip_str = ip.to_string();
                if ip_str != "127.0.0.1" && !ip_str.starts_with("169.254") {
                    // split by dots and get the first 3 octets
                    let parts: Vec<&str> = ip_str.split('.').collect();
                    if parts.len() == 4 {
                        let subnet = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
                        if !subnets.contains(&subnet) {
                            subnets.push(subnet);
                        }
                    }
                }
            }
        }
    }
    // Fallback standard local subnets if none discovered
    if subnets.is_empty() {
        subnets.push("192.168.1".to_string());
        subnets.push("192.168.0".to_string());
        subnets.push("10.0.0".to_string());
    }
    subnets
}

async fn ping_ip(ip: String) -> Option<DiscoveredHost> {
    let addr = format!("{}:1234", ip);
    let timeout_duration = Duration::from_millis(300);
    let connect_fut = TcpStream::connect(&addr);
    
    if tokio::time::timeout(timeout_duration, connect_fut).await.is_ok() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(800))
            .build()
            .ok()?;
        
        let url = format!("http://{}:1234/api/v1/models", ip);
        if let Ok(res) = client.get(&url).send().await {
            if res.status().is_success() {
                return Some(DiscoveredHost {
                    ip: format!("http://{}:1234", ip),
                    name: format!("LM Studio ({})", ip),
                    status: "Online".to_string(),
                });
            }
        }
    }
    None
}

// Commands

#[tauri::command]
async fn scan_subnet(prefix: Option<String>) -> Result<Vec<DiscoveredHost>, String> {
    let subnets = if let Some(pref) = prefix {
        let clean = pref.trim().trim_end_matches('.').to_string();
        if clean.is_empty() { get_active_subnets() } else { vec![clean] }
    } else {
        get_active_subnets()
    };
    let mut tasks = Vec::new();
    let semaphore = Arc::new(Semaphore::new(128)); // Up to 128 concurrent connections

    for subnet in subnets {
        for i in 1..=254 {
            let ip = format!("{}.{}", subnet, i);
            let sem = Arc::clone(&semaphore);
            tasks.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.ok();
                ping_ip(ip).await
            }));
        }
    }

    let mut discovered = Vec::new();
    for task in tasks {
        if let Ok(Some(host)) = task.await {
            discovered.push(host);
        }
    }

    Ok(discovered)
}

#[tauri::command]
fn get_profiles(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    Ok(load_profiles_from_disk(&app))
}

#[tauri::command]
fn save_profile(app: tauri::AppHandle, profile: Profile) -> Result<Vec<Profile>, String> {
    let mut profiles = load_profiles_from_disk(&app);
    
    // If the profile already exists, update it. Otherwise, add it.
    if let Some(pos) = profiles.iter().position(|p| p.id == profile.id) {
        profiles[pos] = profile.clone();
    } else {
        profiles.push(profile.clone());
    }

    // If this profile is active, deactivate others
    if profile.is_active {
        for p in &mut profiles {
            if p.id != profile.id {
                p.is_active = false;
            }
        }
    }

    save_profiles_to_disk(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
fn delete_profile(app: tauri::AppHandle, id: String) -> Result<Vec<Profile>, String> {
    let mut profiles = load_profiles_from_disk(&app);
    profiles.retain(|p| p.id != id);

    // If we deleted the active profile and we still have other profiles, activate the first one
    if !profiles.is_empty() && !profiles.iter().any(|p| p.is_active) {
        profiles[0].is_active = true;
    }

    save_profiles_to_disk(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
fn set_active_profile(app: tauri::AppHandle, id: String) -> Result<Vec<Profile>, String> {
    let mut profiles = load_profiles_from_disk(&app);
    for p in &mut profiles {
        p.is_active = p.id == id;
    }
    save_profiles_to_disk(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
async fn search_hf_repo(repo_id: String) -> Result<Vec<GgufFileOption>, String> {
    let clean_repo = repo_id.trim().trim_start_matches("https://huggingface.co/").trim_end_matches('/');
    if clean_repo.is_empty() {
        return Err("Hugging Face repository ID is empty".to_string());
    }

    let url = format!("https://huggingface.co/api/models/{}/tree/main", clean_repo);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url)
        .header("User-Agent", "LM-Patio/1.0.0")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Hugging Face API: {}. Make sure you are online.", e))?;

    if !res.status().is_success() {
        return Err(format!("Hugging Face API returned status {}. Please check that the repository is public and the ID '{}' is correct.", res.status(), clean_repo));
    }

    #[derive(Deserialize)]
    struct HfFile {
        r#type: String,
        path: String,
        size: Option<u64>,
    }

    let files = res.json::<Vec<HfFile>>()
        .await
        .map_err(|e| format!("Failed to parse Hugging Face response: {}", e))?;

    let mut gguf_options = Vec::new();
    for file in files {
        if file.r#type == "file" && (file.path.to_lowercase().ends_with(".gguf")) {
            let name = file.path;
            let size_bytes = file.size.unwrap_or(0);
            
            // Recommendation heuristics
            let lowercase_name = name.to_lowercase();
            let recommended = lowercase_name.contains("q4_k_m") 
                || lowercase_name.contains("q5_k_m")
                || lowercase_name.contains("q6_k")
                || lowercase_name.contains("q8_0");

            gguf_options.push(GgufFileOption {
                name,
                size_bytes,
                recommended,
            });
        }
    }
    
    // Sort options by size
    gguf_options.sort_by_key(|o| o.size_bytes);
    
    Ok(gguf_options)
}

#[tauri::command]
async fn get_models(host: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/v1/models", host.trim_end_matches('/'));
    let res = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not connect to LM Studio at {}. Error: {}", host, e))?;

    let val = res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse models response from LM Studio: {}", e))?;

    Ok(val)
}

#[tauri::command]
async fn load_model(host: String, model: String, config: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120)) // Model loading can be slow
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/v1/models/load", host.trim_end_matches('/'));
    
    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), serde_json::Value::String(model));
    if let Some(cfg) = config {
        body.insert("config".to_string(), cfg);
    }

    let res = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to load model on server: {}", e))?;

    let val = res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse load model response: {}", e))?;

    Ok(val)
}

#[tauri::command]
async fn unload_model(host: String, instance_id: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/v1/models/unload", host.trim_end_matches('/'));
    
    let mut body = serde_json::Map::new();
    body.insert("instance_id".to_string(), serde_json::Value::String(instance_id));

    let res = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to unload model on server: {}", e))?;

    let val = res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse unload model response: {}", e))?;

    Ok(val)
}

#[tauri::command]
async fn download_model(host: String, model: String, quantization: Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/v1/models/download", host.trim_end_matches('/'));
    
    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), serde_json::Value::String(model));
    if let Some(quant) = quantization {
        body.insert("quantization".to_string(), serde_json::Value::String(quant));
    }

    let res = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to trigger download: {}", e))?;

    let val = res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse download trigger response: {}", e))?;

    Ok(val)
}

#[tauri::command]
async fn get_download_status(host: String, job_id: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/v1/models/download/status/{}", host.trim_end_matches('/'), job_id);
    let res = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to query download status: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Server returned HTTP {}", res.status()));
    }

    let val = res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse download status response: {}", e))?;

    Ok(val)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_subnet,
            get_profiles,
            save_profile,
            delete_profile,
            set_active_profile,
            search_hf_repo,
            get_models,
            load_model,
            unload_model,
            download_model,
            get_download_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
