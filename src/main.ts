import { invoke } from "@tauri-apps/api/core";

// ==========================================================================
// INTERFACES & UI TYPES
// ==========================================================================
interface Profile {
  id: string;
  name: string;
  host: string;
  is_active: boolean;
}

interface DiscoveredHost {
  ip: string;
  name: string;
  status: string;
}

interface GgufFileOption {
  name: string;
  size_bytes: number;
  recommended: boolean;
}

interface LoadedInstance {
  id: string;
  config?: any;
}

interface ModelInstance {
  key: string;
  publisher?: string;
  display_name?: string;
  size_bytes?: number;
  quantization?: {
    name: string;
    bits_per_weight: number;
  };
  loaded_instances: LoadedInstance[];
  format?: string;
  params_string?: string;
  max_context_length?: number;
}

interface DownloadJob {
  status: string;
  bytes_per_second?: number;
  downloaded_bytes?: number;
  total_size_bytes?: number;
  estimated_completion?: string;
}

interface HfSearchResult {
  modelId: string;
  downloads: number;
  likes: number;
}

// ==========================================================================
// STATE MANAGEMENT
// ==========================================================================
let profiles: Profile[] = [];
let activeProfile: Profile | null = null;
let modelLibrary: ModelInstance[] = [];
let activeDownloadsMap = new Map<string, { repoId: string; filename: string }>(); // jobId -> details
let downloadConsecutiveErrorsMap = new Map<string, number>();
let pollTimerId: any = null;

let isConnected = false;
let currentTab: "library" | "downloader" = "library";
let currentSortOption = "downloads";

// Cached Search / Picker States for auto-refresh on profile switch
let lastSearchResults: HfSearchResult[] = [];
let lastSelectedRepoId: string = "";
let lastQuantFiles: GgufFileOption[] = [];

// Modal States
let selectedModelKey: string = "";
let selectedModelSizeBytes: number = 0;

// UI Element Handles
let profilesListEl: HTMLElement;
let btnAddProfileToggle: HTMLButtonElement;
let formAddProfile: HTMLFormElement;
let btnAddProfileCancel: HTMLButtonElement;
let inputProfileName: HTMLInputElement;
let inputProfileHost: HTMLInputElement;

let btnScanSubnet: HTMLButtonElement;
let inputSubnetPrefix: HTMLInputElement;
let scanResultsEl: HTMLElement;

let activeServerNameEl: HTMLElement;
let activeServerBadgeEl: HTMLElement;
let sidebarHostUrlEl: HTMLElement;
let sidebarStatusLabelEl: HTMLElement;
let sidebarStatusDotEl: HTMLElement;
let vramLoadedBadgeEl: HTMLElement;
let btnRefreshDashboard: HTMLButtonElement;

let offlineScreenEl: HTMLElement;
let offlineErrorDetailsEl: HTMLElement;
let btnReconnectFallback: HTMLButtonElement;
let connectedWorkspaceEl: HTMLElement;

let activeModelsContainerEl: HTMLElement;
let storedModelsGridEl: HTMLElement;
let librarySearchEl: HTMLInputElement;

// Tab Navigation Elements
let tabBtnLibraryEl: HTMLButtonElement;
let tabBtnDownloaderEl: HTMLButtonElement;
let tabContentLibraryEl: HTMLElement;
let tabContentDownloaderEl: HTMLElement;
let downloadActiveDotEl: HTMLElement;

// UNIFIED Hugging Face Downloader elements
let formHfUnified: HTMLFormElement;
let hfUnifiedInputEl: HTMLInputElement;
let btnSubmitUnifiedEl: HTMLButtonElement;
let btnClearSearchEl: HTMLButtonElement;
let hfSearchResultsBoxEl: HTMLElement;

let quantPickerAreaEl: HTMLElement;
let quantPickerRepoTitleEl: HTMLElement;
let btnCloseQuantPickerEl: HTMLButtonElement;
let quantFilesListEl: HTMLElement;

let downloadsTrackerSectionEl: HTMLElement;
let downloadsListEl: HTMLElement;

// Load Config Modal Handles
let loadModalEl: HTMLElement;
let btnCloseLoadModalEl: HTMLButtonElement;
let btnCancelLoadModalEl: HTMLButtonElement;
let formLoadParametersEl: HTMLFormElement;
let loadModalModelNameEl: HTMLElement;
let loadModalModelSizeEl: HTMLElement;

let vramEstimateTotalEl: HTMLElement;
let vramEstimateProgressEl: HTMLElement;
let vramEstimateWeightsEl: HTMLElement;
let vramEstimateKvEl: HTMLElement;

let paramGpuRatioEl: HTMLInputElement;
let paramGpuRatioValEl: HTMLElement;
let paramContextLengthEl: HTMLSelectElement;
let paramKvPrecisionEl: HTMLSelectElement;
let paramFlashAttentionEl: HTMLInputElement;

// ==========================================================================
// DUAL-MODE BRIDGE (TAURI VS BROWSER FETCH)
// ==========================================================================
const isTauri = (): boolean => {
  return typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;
};

async function apiGetProfiles(): Promise<Profile[]> {
  if (isTauri()) {
    return await invoke<Profile[]>("get_profiles");
  } else {
    const data = localStorage.getItem("lm_patio_profiles");
    if (data) {
      return JSON.parse(data);
    }
    const defaults = [
      {
        id: "default-local",
        name: "Local LM Studio",
        host: "http://localhost:1234",
        is_active: true
      }
    ];
    localStorage.setItem("lm_patio_profiles", JSON.stringify(defaults));
    return defaults;
  }
}

async function apiSaveProfile(profile: Profile): Promise<Profile[]> {
  if (isTauri()) {
    return await invoke<Profile[]>("save_profile", { profile });
  } else {
    let list = await apiGetProfiles();
    const pos = list.findIndex(p => p.id === profile.id);
    if (pos >= 0) {
      list[pos] = profile;
    } else {
      list.push(profile);
    }

    if (profile.is_active) {
      list = list.map(p => ({
        ...p,
        is_active: p.id === profile.id
      }));
    }

    localStorage.setItem("lm_patio_profiles", JSON.stringify(list));
    return list;
  }
}

async function apiDeleteProfile(id: string): Promise<Profile[]> {
  if (isTauri()) {
    return await invoke<Profile[]>("delete_profile", { id });
  } else {
    let list = await apiGetProfiles();
    list = list.filter(p => p.id !== id);

    if (list.length > 0 && !list.some(p => p.is_active)) {
      list[0].is_active = true;
    }

    localStorage.setItem("lm_patio_profiles", JSON.stringify(list));
    return list;
  }
}

async function apiSetActiveProfile(id: string): Promise<Profile[]> {
  if (isTauri()) {
    return await invoke<Profile[]>("set_active_profile", { id });
  } else {
    let list = await apiGetProfiles();
    list = list.map(p => ({
      ...p,
      is_active: p.id === id
    }));
    localStorage.setItem("lm_patio_profiles", JSON.stringify(list));
    return list;
  }
}

async function detectLocalSubnets(): Promise<string[]> {
  return new Promise((resolve) => {
    const subnets: string[] = [];
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("");
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .catch(() => {});
        
      pc.onicecandidate = (event) => {
        if (!event || !event.candidate) {
          resolve(subnets);
          return;
        }
        
        const candidate = event.candidate.candidate;
        // Parse IPv4 address from ICE candidate string
        const parts = candidate.split(" ");
        for (const part of parts) {
          if (/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(part)) {
            if (part !== "127.0.0.1" && !part.startsWith("169.254")) {
              const octets = part.split(".");
              const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
              if (!subnets.includes(prefix)) {
                subnets.push(prefix);
              }
            }
          }
        }
      };
      
      // Safety timeout in case candidate gathering takes too long or fails
      setTimeout(() => {
        resolve(subnets);
      }, 350);
    } catch (e) {
      resolve(subnets);
    }
  });
}

async function apiScanSubnet(prefix: string): Promise<DiscoveredHost[]> {
  if (isTauri()) {
    return await invoke<DiscoveredHost[]>("scan_subnet", { prefix: prefix || null });
  } else {
    const hosts = ["http://localhost:1234", "http://127.0.0.1:1234"];
    
    let subnetsToScan: string[] = [];
    if (prefix) {
      subnetsToScan.push(prefix.replace(/\.+$/, ""));
    } else {
      // Auto-detect local subnets using WebRTC!
      const detected = await detectLocalSubnets();
      if (detected.length > 0) {
        subnetsToScan = detected;
      } else {
        // Fallback common local subnets
        subnetsToScan = ["192.168.1", "192.168.0"];
      }
    }
    
    for (const subnet of subnetsToScan) {
      // Sweep hosts 1..45 (common ranges and VPN targets)
      for (let i = 1; i <= 45; i++) {
        hosts.push(`http://${subnet}.${i}:1234`);
      }
    }
    
    const discovered: DiscoveredHost[] = [];
    
    await Promise.all(
      hosts.map(async host => {
        try {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), 600);
          
          const res = await fetch(`${host}/api/v1/models`, {
            method: "GET",
            signal: controller.signal
          });
          clearTimeout(id);
          
          if (res.ok) {
            discovered.push({
              ip: host,
              name: `LM Studio (${host.replace("http://", "").replace(":1234", "")})`,
              status: "Online"
            });
          }
        } catch (e) {
          // ignore offline
        }
      })
    );
    return discovered;
  }
}

async function apiGetModels(host: string): Promise<any> {
  if (isTauri()) {
    return await invoke<any>("get_models", { host });
  } else {
    const res = await fetch(`${host}/api/v1/models`, { method: "GET" });
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
    return await res.json();
  }
}

async function apiLoadModel(host: string, model: string, config: any): Promise<any> {
  if (isTauri()) {
    return await invoke<any>("load_model", { host, model, config: config || null });
  } else {
    const res = await fetch(`${host}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, config })
    });
    if (!res.ok) throw new Error(`Model load failed: HTTP ${res.status}`);
    return await res.json();
  }
}

async function apiUnloadModel(host: string, instanceId: string): Promise<any> {
  if (isTauri()) {
    return await invoke<any>("unload_model", { host, instance_id: instanceId });
  } else {
    const res = await fetch(`${host}/api/v1/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: instanceId })
    });
    if (!res.ok) throw new Error(`Model unload failed: HTTP ${res.status}`);
    return await res.json();
  }
}

async function apiDownloadModel(host: string, model: string, quantization?: string): Promise<any> {
  if (isTauri()) {
    return await invoke<any>("download_model", { host, model, quantization: quantization || null });
  } else {
    const body: any = { model };
    if (quantization) {
      body.quantization = quantization;
    }
    const res = await fetch(`${host}/api/v1/models/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
    return await res.json();
  }
}

async function apiGetDownloadStatus(host: string, jobId: string): Promise<DownloadJob> {
  if (isTauri()) {
    return await invoke<DownloadJob>("get_download_status", { host, job_id: jobId });
  } else {
    const res = await fetch(`${host}/api/v1/models/download/status/${jobId}`, { method: "GET" });
    if (!res.ok) throw new Error(`Download status fetch failed: HTTP ${res.status}`);
    return await res.json();
  }
}

async function apiSearchHfRepo(repoId: string): Promise<GgufFileOption[]> {
  if (isTauri()) {
    return await invoke<GgufFileOption[]>("search_hf_repo", { repoId });
  } else {
    const cleanRepo = repoId.trim().replace(/^https:\/\/huggingface\.co\//, "").replace(/\/+$/, "");
    if (!cleanRepo) throw new Error("Repository ID cannot be empty.");

    const res = await fetch(`https://huggingface.co/api/models/${cleanRepo}/tree/main`);
    if (!res.ok) {
      throw new Error(`Hugging Face API returned status ${res.status}. Make sure the repository is public and the ID is correct.`);
    }

    const files = await res.json();
    if (!Array.isArray(files)) {
      throw new Error("Invalid response format received from Hugging Face.");
    }

    const ggufOptions: GgufFileOption[] = [];
    for (const file of files) {
      if (file.type === "file" && file.path.toLowerCase().endsWith(".gguf")) {
        const name = file.path;
        const size_bytes = file.size || 0;
        const lowercaseName = name.toLowerCase();
        
        // Recommendation heuristics
        const recommended = lowercaseName.includes("q4_k_m") 
          || lowercaseName.includes("q5_k_m")
          || lowercaseName.includes("q6_k")
          || lowercaseName.includes("q8_0");

        ggufOptions.push({ name, size_bytes, recommended });
      }
    }

    ggufOptions.sort((a, b) => a.size_bytes - b.size_bytes);
    return ggufOptions;
  }
}

async function apiQueryHfCatalog(query: string): Promise<HfSearchResult[]> {
  const cleanQuery = encodeURIComponent(query.trim());
  const url = `https://huggingface.co/api/models?search=${cleanQuery}&filter=gguf&sort=${currentSortOption}&direction=-1&limit=15`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF search returned status ${res.status}`);
  
  const list = await res.json();
  if (!Array.isArray(list)) return [];
  
  return list.map((item: any) => ({
    modelId: item.modelId,
    downloads: item.downloads || 0,
    likes: item.likes || 0
  }));
}

// ==========================================================================
// INITIALIZATION
// ==========================================================================
window.addEventListener("DOMContentLoaded", async () => {
  // Bind UI Handles
  profilesListEl = document.getElementById("profiles-list")!;
  btnAddProfileToggle = document.getElementById("btn-add-profile-toggle") as HTMLButtonElement;
  formAddProfile = document.getElementById("form-add-profile") as HTMLFormElement;
  btnAddProfileCancel = document.getElementById("btn-add-profile-cancel") as HTMLButtonElement;
  inputProfileName = document.getElementById("profile-name") as HTMLInputElement;
  inputProfileHost = document.getElementById("profile-host") as HTMLInputElement;

  btnScanSubnet = document.getElementById("btn-scan-subnet") as HTMLButtonElement;
  inputSubnetPrefix = document.getElementById("subnet-prefix-input") as HTMLInputElement;
  scanResultsEl = document.getElementById("scan-results")!;

  activeServerNameEl = document.getElementById("active-server-name")!;
  activeServerBadgeEl = document.getElementById("active-server-badge")!;
  sidebarHostUrlEl = document.getElementById("sidebar-host-url")!;
  sidebarStatusLabelEl = document.getElementById("sidebar-status-label")!;
  sidebarStatusDotEl = document.getElementById("sidebar-status-dot")!;
  vramLoadedBadgeEl = document.getElementById("vram-loaded-badge")!;
  btnRefreshDashboard = document.getElementById("btn-refresh-dashboard") as HTMLButtonElement;

  offlineScreenEl = document.getElementById("offline-screen")!;
  offlineErrorDetailsEl = document.getElementById("offline-error-details")!;
  btnReconnectFallback = document.getElementById("btn-reconnect-fallback") as HTMLButtonElement;
  connectedWorkspaceEl = document.getElementById("connected-workspace")!;

  activeModelsContainerEl = document.getElementById("active-models-container")!;
  storedModelsGridEl = document.getElementById("stored-models-grid")!;
  librarySearchEl = document.getElementById("library-search") as HTMLInputElement;

  // Tab Navigation Elements
  tabBtnLibraryEl = document.getElementById("tab-btn-library") as HTMLButtonElement;
  tabBtnDownloaderEl = document.getElementById("tab-btn-downloader") as HTMLButtonElement;
  tabContentLibraryEl = document.getElementById("tab-content-library")!;
  tabContentDownloaderEl = document.getElementById("tab-content-downloader")!;
  downloadActiveDotEl = document.getElementById("download-active-dot")!;

  // UNIFIED Hugging Face Downloader
  formHfUnified = document.getElementById("form-hf-unified") as HTMLFormElement;
  hfUnifiedInputEl = document.getElementById("hf-unified-input") as HTMLInputElement;
  btnSubmitUnifiedEl = document.getElementById("btn-submit-unified") as HTMLButtonElement;
  btnClearSearchEl = document.getElementById("btn-clear-search") as HTMLButtonElement;
  hfSearchResultsBoxEl = document.getElementById("hf-search-results-box")!;

  quantPickerAreaEl = document.getElementById("quant-picker-area")!;
  quantPickerRepoTitleEl = document.getElementById("quant-picker-repo-title")!;
  btnCloseQuantPickerEl = document.getElementById("btn-close-quant-picker") as HTMLButtonElement;
  quantFilesListEl = document.getElementById("quant-files-list")!;

  downloadsTrackerSectionEl = document.getElementById("downloads-tracker-section")!;
  downloadsListEl = document.getElementById("downloads-list")!;

  // Load Parameters Modal Handles
  loadModalEl = document.getElementById("load-modal")!;
  btnCloseLoadModalEl = document.getElementById("btn-close-load-modal") as HTMLButtonElement;
  btnCancelLoadModalEl = document.getElementById("btn-cancel-load-modal") as HTMLButtonElement;
  formLoadParametersEl = document.getElementById("form-load-parameters") as HTMLFormElement;
  loadModalModelNameEl = document.getElementById("load-modal-model-name")!;
  loadModalModelSizeEl = document.getElementById("load-modal-model-size")!;

  vramEstimateTotalEl = document.getElementById("vram-estimate-total")!;
  vramEstimateProgressEl = document.getElementById("vram-estimate-progress")!;
  vramEstimateWeightsEl = document.getElementById("vram-estimate-weights")!;
  vramEstimateKvEl = document.getElementById("vram-estimate-kv")!;

  paramGpuRatioEl = document.getElementById("param-gpu-ratio") as HTMLInputElement;
  paramGpuRatioValEl = document.getElementById("param-gpu-ratio-val")!;
  paramContextLengthEl = document.getElementById("param-context-length") as HTMLSelectElement;
  paramKvPrecisionEl = document.getElementById("param-kv-precision") as HTMLSelectElement;
  paramFlashAttentionEl = document.getElementById("param-flash-attention") as HTMLInputElement;

  // Event Listeners
  btnAddProfileToggle.addEventListener("click", () => {
    formAddProfile.classList.toggle("hidden");
  });

  btnAddProfileCancel.addEventListener("click", () => {
    formAddProfile.classList.add("hidden");
    formAddProfile.reset();
  });

  formAddProfile.addEventListener("submit", handleAddProfile);
  btnScanSubnet.addEventListener("click", handleScanSubnet);
  btnRefreshDashboard.addEventListener("click", handleRefreshDashboard);
  btnReconnectFallback.addEventListener("click", handleRefreshDashboard);
  
  librarySearchEl.addEventListener("input", () => {
    renderStoredModels();
  });

  // Tab Navigation Switching
  tabBtnLibraryEl.addEventListener("click", () => {
    currentTab = "library";
    updateActiveTabViews();
    
    // Auto-close sidebar on mobile
    const sidebarEl = document.querySelector(".sidebar");
    const sidebarOverlay = document.getElementById("sidebar-overlay");
    if (sidebarEl && sidebarOverlay) {
      sidebarEl.classList.remove("open");
      sidebarOverlay.classList.remove("active");
    }
  });

  tabBtnDownloaderEl.addEventListener("click", () => {
    currentTab = "downloader";
    updateActiveTabViews();
    
    // Auto-close sidebar on mobile
    const sidebarEl = document.querySelector(".sidebar");
    const sidebarOverlay = document.getElementById("sidebar-overlay");
    if (sidebarEl && sidebarOverlay) {
      sidebarEl.classList.remove("open");
      sidebarOverlay.classList.remove("active");
    }
  });

  // Mobile Sidebar Toggle Hooks
  const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  const sidebarEl = document.querySelector(".sidebar");

  if (btnToggleSidebar && sidebarOverlay && sidebarEl) {
    btnToggleSidebar.addEventListener("click", () => {
      sidebarEl.classList.toggle("open");
      sidebarOverlay.classList.toggle("active");
    });

    sidebarOverlay.addEventListener("click", () => {
      sidebarEl.classList.remove("open");
      sidebarOverlay.classList.remove("active");
    });
  }

  // Hugging Face Unified Handlers
  formHfUnified.addEventListener("submit", handleHfUnifiedSubmit);
  btnCloseQuantPickerEl.addEventListener("click", (e) => {
    e.preventDefault();
    quantPickerAreaEl.classList.add("hidden");
    hfSearchResultsBoxEl.classList.remove("hidden");
  });

  // Show/Hide Clear Search button based on search input content
  hfUnifiedInputEl.addEventListener("input", () => {
    if (hfUnifiedInputEl.value.trim() !== "") {
      btnClearSearchEl.classList.remove("hidden");
    } else {
      btnClearSearchEl.classList.add("hidden");
    }
  });

  btnClearSearchEl.addEventListener("click", () => {
    hfUnifiedInputEl.value = "";
    btnClearSearchEl.classList.add("hidden");
    hfSearchResultsBoxEl.classList.add("hidden");
    quantPickerAreaEl.classList.add("hidden");
  });

  // Hugging Face Sorting Buttons Toggle
  const sortButtons = document.querySelectorAll(".btn-sort");
  sortButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      sortButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      const sortVal = btn.getAttribute("data-sort") || "downloads";
      currentSortOption = sortVal;
      
      const query = hfUnifiedInputEl.value.trim();
      if (query) {
        formHfUnified.requestSubmit();
      }
    });
  });

  // Modal Parameter Watchers
  paramGpuRatioEl.addEventListener("input", () => {
    paramGpuRatioValEl.textContent = `${paramGpuRatioEl.value}%`;
    updateVramEstimate();
  });
  paramContextLengthEl.addEventListener("change", updateVramEstimate);
  paramKvPrecisionEl.addEventListener("change", updateVramEstimate);

  // Modal Controls
  btnCloseLoadModalEl.addEventListener("click", hideLoadModal);
  btnCancelLoadModalEl.addEventListener("click", hideLoadModal);
  formLoadParametersEl.addEventListener("submit", executeModelLoad);

  // Load Saved Profiles
  await loadProfiles();
  
  // Start Polling Timer (Runs background download checks)
  startPollingDownloads();
});

// ==========================================================================
// PROFILE MANAGEMENT
// ==========================================================================
async function loadProfiles() {
  try {
    const list = await apiGetProfiles();
    profiles = list;
    activeProfile = profiles.find(p => p.is_active) || null;
    renderProfilesList();
    
    if (activeProfile) {
      await connectToProfile(activeProfile);
    } else {
      showOfflineView("No active server profile selected. Add or select a server to begin.");
    }
  } catch (err: any) {
    console.error("Failed to load profiles:", err);
    showOfflineView("Error reading stored profiles: " + err);
  }
}

function renderProfilesList() {
  profilesListEl.innerHTML = "";
  
  if (profiles.length === 0) {
    profilesListEl.innerHTML = `<div class="no-results-msg">No stored profiles. Add one manually or scan the subnet.</div>`;
    return;
  }

  profiles.forEach(profile => {
    const isSelected = activeProfile && activeProfile.id === profile.id;
    
    const card = document.createElement("div");
    card.className = `profile-card ${isSelected ? 'active' : ''}`;
    
    card.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".btn-delete-profile")) return;
      await selectActiveProfile(profile.id);
    });

    card.innerHTML = `
      <div class="profile-info">
        <span class="profile-label">${escapeHtml(profile.name)}</span>
        <span class="profile-url">${escapeHtml(profile.host)}</span>
      </div>
      <div class="profile-actions">
        <button class="icon-btn btn-delete-profile" title="Delete Profile" data-id="${profile.id}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    const btnDelete = card.querySelector(".btn-delete-profile") as HTMLButtonElement;
    btnDelete.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete profile "${profile.name}"?`)) {
        await deleteProfile(profile.id);
      }
    });

    profilesListEl.appendChild(card);
  });
}

async function handleAddProfile(e: Event) {
  e.preventDefault();
  const name = inputProfileName.value.trim();
  let host = inputProfileHost.value.trim();
  
  if (!name || !host) return;

  if (!host.startsWith("http://") && !host.startsWith("https://")) {
    host = "http://" + host;
  }
  host = host.replace(/\/+$/, "");

  const newProfile: Profile = {
    id: "prof-" + Date.now(),
    name,
    host,
    is_active: true
  };

  try {
    const updated = await apiSaveProfile(newProfile);
    profiles = updated;
    activeProfile = profiles.find(p => p.id === newProfile.id) || null;
    formAddProfile.classList.add("hidden");
    formAddProfile.reset();
    renderProfilesList();
    if (activeProfile) {
      await connectToProfile(activeProfile);
    }
  } catch (err: any) {
    alert("Failed to save profile: " + err);
  }
}

async function deleteProfile(id: string) {
  try {
    const updated = await apiDeleteProfile(id);
    profiles = updated;
    activeProfile = profiles.find(p => p.is_active) || null;
    renderProfilesList();
    if (activeProfile) {
      await connectToProfile(activeProfile);
    } else {
      sidebarHostUrlEl.textContent = "No server selected";
      sidebarStatusLabelEl.textContent = "Offline";
      sidebarStatusDotEl.className = "status-indicator-dot disconnected";
      showOfflineView("No active server profile selected. Add or select a server to begin.");
    }
  } catch (err: any) {
    alert("Failed to delete profile: " + err);
  }
}

async function selectActiveProfile(id: string) {
  try {
    const updated = await apiSetActiveProfile(id);
    profiles = updated;
    activeProfile = profiles.find(p => p.is_active) || null;
    renderProfilesList();
    
    // Auto-close sidebar on mobile
    const sidebarEl = document.querySelector(".sidebar");
    const sidebarOverlay = document.getElementById("sidebar-overlay");
    if (sidebarEl && sidebarOverlay) {
      sidebarEl.classList.remove("open");
      sidebarOverlay.classList.remove("active");
    }

    if (activeProfile) {
      await connectToProfile(activeProfile);
    }
  } catch (err: any) {
    console.error("Failed to select profile:", err);
  }
}

// ==========================================================================
// CONNECTION MANAGEMENT & TELEMETRY
// ==========================================================================
async function connectToProfile(profile: Profile) {
  // Auto-close sidebar on mobile
  const sidebarEl = document.querySelector(".sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  if (sidebarEl && sidebarOverlay) {
    sidebarEl.classList.remove("open");
    sidebarOverlay.classList.remove("active");
  }

  sidebarHostUrlEl.textContent = profile.host;
  sidebarStatusLabelEl.textContent = "Connecting...";
  sidebarStatusDotEl.className = "status-indicator-dot offline";
  
  activeServerNameEl.textContent = profile.name;
  activeServerBadgeEl.textContent = "connecting...";
  activeServerBadgeEl.className = "host-badge";

  try {
    const data = await apiGetModels(profile.host);
    if (data && Array.isArray(data.models)) {
      modelLibrary = data.models;
      
      sidebarStatusLabelEl.textContent = "Online";
      sidebarStatusDotEl.className = "status-indicator-dot online";
      
      activeServerBadgeEl.textContent = profile.host;
      activeServerBadgeEl.className = "host-badge online";
      
      showConnectedView();
      renderActiveModels();
      renderStoredModels();

      // Reactively refresh the Quant Picker UI if it's currently open
      if (lastSelectedRepoId && lastQuantFiles.length > 0) {
        renderQuantPicker(lastSelectedRepoId, lastQuantFiles);
      }
    } else {
      throw new Error("Invalid models format received from LM Studio");
    }
  } catch (err: any) {
    console.error("Connection failed:", err);
    sidebarStatusLabelEl.textContent = "Offline";
    sidebarStatusDotEl.className = "status-indicator-dot disconnected";
    
    activeServerBadgeEl.textContent = "offline";
    activeServerBadgeEl.className = "host-badge disconnected";
    
    showOfflineView(err.toString());
  }
}

async function handleRefreshDashboard() {
  if (!activeProfile) {
    alert("No active server profile selected to refresh.");
    return;
  }
  const btn = btnRefreshDashboard;
  btn.disabled = true;
  await connectToProfile(activeProfile);
  btn.disabled = false;
}

function updateActiveTabViews() {
  // Update tab button active states
  if (currentTab === "library") {
    tabBtnLibraryEl.classList.add("active");
    tabBtnDownloaderEl.classList.remove("active");
  } else {
    tabBtnDownloaderEl.classList.add("active");
    tabBtnLibraryEl.classList.remove("active");
  }

  // Ensure workspace container is always visible
  connectedWorkspaceEl.classList.remove("hidden");

  if (currentTab === "library") {
    tabContentDownloaderEl.classList.add("hidden");
    
    if (isConnected) {
      tabContentLibraryEl.classList.remove("hidden");
      offlineScreenEl.classList.add("hidden");
      vramLoadedBadgeEl.classList.remove("hidden");
    } else {
      tabContentLibraryEl.classList.add("hidden");
      offlineScreenEl.classList.remove("hidden");
      vramLoadedBadgeEl.classList.add("hidden");
    }
  } else {
    tabContentLibraryEl.classList.add("hidden");
    offlineScreenEl.classList.add("hidden");
    tabContentDownloaderEl.classList.remove("hidden");
    
    // Manage offline banner in Downloader tab
    const warningEl = document.getElementById("downloader-offline-warning");
    if (warningEl) {
      if (isConnected) {
        warningEl.classList.add("hidden");
      } else {
        warningEl.classList.remove("hidden");
      }
    }
  }
}

function showOfflineView(errorMessage: string) {
  isConnected = false;
  offlineErrorDetailsEl.textContent = errorMessage;
  updateActiveTabViews();
  
  // Instantly refresh search results or quant picker when connection details change
  if (!hfSearchResultsBoxEl.classList.contains("hidden") && lastSearchResults.length > 0) {
    renderHfSearchResults(lastSearchResults);
  }
  if (!quantPickerAreaEl.classList.contains("hidden") && lastQuantFiles.length > 0) {
    renderQuantPicker(lastSelectedRepoId, lastQuantFiles);
  }
}

function showConnectedView() {
  isConnected = true;
  updateActiveTabViews();
  
  // Instantly refresh search results or quant picker when connection details change
  if (!hfSearchResultsBoxEl.classList.contains("hidden") && lastSearchResults.length > 0) {
    renderHfSearchResults(lastSearchResults);
  }
  if (!quantPickerAreaEl.classList.contains("hidden") && lastQuantFiles.length > 0) {
    renderQuantPicker(lastSelectedRepoId, lastQuantFiles);
  }
}

// ==========================================================================
// SUBNET PORT SCANNER (AUTO-DISCOVERY)
// ==========================================================================
async function handleScanSubnet() {
  const btn = btnScanSubnet;
  const spinner = btn.querySelector(".spinner")!;
  const btnText = btn.querySelector(".btn-text")!;
  
  const prefix = inputSubnetPrefix.value.trim();

  btn.disabled = true;
  spinner.classList.remove("hidden");
  btnText.textContent = "Scanning...";
  scanResultsEl.innerHTML = `<div class="no-results-msg">Sweeping network interfaces...</div>`;

  try {
    const discovered = await apiScanSubnet(prefix);
    renderScanResults(discovered);
  } catch (err: any) {
    scanResultsEl.innerHTML = `<div class="no-results-msg" style="color: var(--color-danger);">Sweep failed: ${escapeHtml(err.toString())}</div>`;
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
    btnText.textContent = "Scan Subnet";
  }
}

function renderScanResults(hosts: DiscoveredHost[]) {
  scanResultsEl.innerHTML = "";
  
  if (hosts.length === 0) {
    scanResultsEl.innerHTML = `<div class="no-results-msg">No active servers found. Ensure port 1234 is enabled.</div>`;
    return;
  }

  hosts.forEach(host => {
    const card = document.createElement("div");
    card.className = "scan-card";
    card.innerHTML = `
      <div class="scan-host-info">
        <span class="scan-ip">${escapeHtml(host.ip)}</span>
        <span class="scan-status">${escapeHtml(host.status)}</span>
      </div>
      <button class="btn btn-primary btn-sm">Connect</button>
    `;

    card.addEventListener("click", async () => {
      const existing = profiles.find(p => p.host === host.ip);
      if (existing) {
        await selectActiveProfile(existing.id);
      } else {
        const newProfile: Profile = {
          id: "prof-" + Date.now(),
          name: host.name,
          host: host.ip,
          is_active: true
        };
        const updated = await apiSaveProfile(newProfile);
        profiles = updated;
        activeProfile = profiles.find(p => p.id === newProfile.id) || null;
        renderProfilesList();
        if (activeProfile) {
          await connectToProfile(activeProfile);
        }
      }
    });

    scanResultsEl.appendChild(card);
  });
}

// ==========================================================================
// ACTIVE LOADED MODELS & VRAM CONTROL
// ==========================================================================
function renderActiveModels() {
  activeModelsContainerEl.innerHTML = "";
  
  const loaded = modelLibrary.filter(m => Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0);
  const activeVramSection = document.getElementById("active-vram-section");
  
  if (loaded.length > 0) {
    vramLoadedBadgeEl.textContent = `${loaded.length} Model${loaded.length > 1 ? 's' : ''} Loaded`;
    vramLoadedBadgeEl.style.display = "inline-block";
    if (activeVramSection) activeVramSection.classList.remove("hidden");
  } else {
    vramLoadedBadgeEl.textContent = "0 Models Loaded";
    vramLoadedBadgeEl.style.display = "none";
    if (activeVramSection) activeVramSection.classList.add("hidden");
    return;
  }

  loaded.forEach(model => {
    const meta = parseModelKey(model.key);
    const sizeStr = model.size_bytes ? (model.size_bytes / (1024*1024*1024)).toFixed(2) + " GB" : "Unknown size";
    const quantName = model.quantization?.name || model.params_string || "GGUF";
    const instanceId = model.loaded_instances[0].id;

    const card = document.createElement("div");
    card.className = "active-model-card";
    card.innerHTML = `
      <div class="active-model-meta">
        <div class="active-badge-pulse"></div>
        <div class="active-model-info">
          <span class="active-model-name">${escapeHtml(meta.name)}</span>
          <div class="active-model-stats">
            <span>Publisher: ${escapeHtml(model.publisher || meta.publisher)}</span>
            <span class="stat-divider">|</span>
            <span>Quant: ${escapeHtml(quantName)}</span>
            <span class="stat-divider">|</span>
            <span>Size: ${sizeStr}</span>
          </div>
        </div>
      </div>
      <button class="btn btn-danger btn-sm btn-unload" data-id="${instanceId}">Unload Model</button>
    `;

    const btnUnload = card.querySelector(".btn-unload") as HTMLButtonElement;
    btnUnload.addEventListener("click", async () => {
      btnUnload.disabled = true;
      btnUnload.textContent = "Unloading...";
      await handleUnloadModel(instanceId);
    });

    activeModelsContainerEl.appendChild(card);
  });
}

async function handleUnloadModel(instanceId: string) {
  if (!activeProfile) return;
  try {
    await apiUnloadModel(activeProfile.host, instanceId);
    await connectToProfile(activeProfile);
  } catch (err: any) {
    alert("Failed to unload model: " + err);
    await connectToProfile(activeProfile!);
  }
}

// ==========================================================================
// STORED MODELS LIBRARY GRID & PARAMETERS MODAL
// ==========================================================================
function renderStoredModels() {
  storedModelsGridEl.innerHTML = "";
  
  const searchFilter = librarySearchEl.value.trim().toLowerCase();
  
  const filtered = modelLibrary.filter(model => {
    if (searchFilter) {
      const matchName = model.key.toLowerCase().includes(searchFilter);
      const matchPub = (model.publisher || "").toLowerCase().includes(searchFilter);
      const matchDisp = (model.display_name || "").toLowerCase().includes(searchFilter);
      return matchName || matchPub || matchDisp;
    }
    return true;
  });

  if (filtered.length === 0) {
    storedModelsGridEl.innerHTML = `
      <div class="no-results-msg" style="grid-column: 1 / -1; padding: 40px;">
        No stored GGUF files match your query.
      </div>
    `;
    return;
  }

  filtered.forEach(model => {
    const meta = parseModelKey(model.key);
    const sizeStr = model.size_bytes ? (model.size_bytes / (1024*1024*1024)).toFixed(2) + " GB" : "Unknown size";
    
    const isLoaded = Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0;
    const quantName = model.quantization?.name || model.params_string || meta.quant;
    const formatLabel = model.format || "GGUF";

    const card = document.createElement("div");
    card.className = "model-card";
    
    card.innerHTML = `
      <div class="model-card-header">
        <span class="model-family">${escapeHtml(model.publisher || meta.publisher)}</span>
        <h4 class="model-name" title="${escapeHtml(model.key)}">${escapeHtml(meta.name)}</h4>
        <div class="model-tags">
          <span class="tag tag-accent">${escapeHtml(formatLabel.toUpperCase())}</span>
          <span class="tag">${escapeHtml(quantName)}</span>
        </div>
      </div>
      <div class="model-details">
        <div>
          <span class="detail-label">File Size</span>
          <div class="detail-val">${sizeStr}</div>
        </div>
        <div>
          <span class="detail-label">Architecture</span>
          <div class="detail-val">${escapeHtml(model.params_string || "N/A")}</div>
        </div>
      </div>
      <div class="model-card-actions">
        ${
          isLoaded 
          ? `<button class="btn btn-danger btn-unload-grid" data-id="${model.key}">Unload VRAM</button>`
          : `<button class="btn btn-primary btn-load-grid" data-id="${model.key}">Load into VRAM</button>`
        }
      </div>
    `;

    if (isLoaded) {
      const instanceId = model.loaded_instances[0].id;
      const btnUnload = card.querySelector(".btn-unload-grid") as HTMLButtonElement;
      btnUnload.addEventListener("click", async () => {
        btnUnload.disabled = true;
        btnUnload.textContent = "Unloading...";
        await handleUnloadModel(instanceId);
      });
    } else {
      const btnLoad = card.querySelector(".btn-load-grid") as HTMLButtonElement;
      btnLoad.addEventListener("click", () => {
        showLoadModal(model.key, model.size_bytes || 0);
      });
    }

    storedModelsGridEl.appendChild(card);
  });
}

// Helper to parse key
function parseModelKey(key: string) {
  const parts = key.split('/');
  let name = key;
  let publisher = "Local Store";
  let quant = "GGUF";
  
  if (parts.length >= 3) {
    publisher = parts[0];
    name = parts[parts.length - 1].replace(/\.[gG][gG][uU][fF]$/, "");
  } else if (parts.length === 2) {
    publisher = parts[0];
    name = parts[1].replace(/\.[gG][gG][uU][fF]$/, "");
  } else {
    name = key.replace(/\.[gG][gG][uU][fF]$/, "");
  }
  
  const quantMatch = name.match(/(?:(?:Q|IQ)[0-9]_(?:K_[A-Z]+|K|[0-9_]+|[A-Z]+)|BF16|FP16|FP32)/i);
  if (quantMatch) {
    quant = quantMatch[0].toUpperCase();
  }
  
  return { name, publisher, quant };
}

// ==========================================================================
// LOAD CONFIG PARAMETERS MODAL & VRAM ESTIMATOR CALCULATOR
// ==========================================================================
function showLoadModal(modelKey: string, sizeBytes: number) {
  selectedModelKey = modelKey;
  selectedModelSizeBytes = sizeBytes;
  
  const meta = parseModelKey(modelKey);
  const sizeGB = (sizeBytes / (1024*1024*1024)).toFixed(2);

  loadModalModelNameEl.textContent = meta.name;
  loadModalModelSizeEl.textContent = `${sizeGB} GB`;

  // Find model from library to discover native max context size
  const model = modelLibrary.find(m => m.key === modelKey);
  const maxContext = model?.max_context_length || 4096;

  // Dynamically populate context options up to max native context length
  const select = paramContextLengthEl;
  select.innerHTML = "";

  const maxOption = document.createElement("option");
  maxOption.value = maxContext.toString();
  maxOption.textContent = `Model Native Max (${maxContext.toLocaleString()} tokens)`;
  maxOption.selected = true;
  select.appendChild(maxOption);

  const standards = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
  standards.forEach(val => {
    if (val < maxContext) {
      const opt = document.createElement("option");
      opt.value = val.toString();
      opt.textContent = `${val.toLocaleString()} tokens`;
      select.appendChild(opt);
    }
  });

  // Reset parameters
  paramGpuRatioEl.value = "100";
  paramGpuRatioValEl.textContent = "100%";
  paramKvPrecisionEl.value = "fp16";
  paramFlashAttentionEl.checked = true;

  updateVramEstimate();
  loadModalEl.classList.remove("hidden");
}

function hideLoadModal() {
  loadModalEl.classList.add("hidden");
}

// REAL-TIME Telemetry Math
function updateVramEstimate() {
  const gpuPercent = parseInt(paramGpuRatioEl.value);
  const contextLength = parseInt(paramContextLengthEl.value);
  const kvPrecision = paramKvPrecisionEl.value;

  const modelSizeGB = selectedModelSizeBytes / (1024*1024*1024);
  
  // Weights offloaded VRAM
  const weightsVram = modelSizeGB * (gpuPercent / 100);

  // KV Cache VRAM calculation
  let kvCoeff = 0.00012;
  if (kvPrecision === "q8_0") {
    kvCoeff = 0.00006;
  } else if (kvPrecision === "q4_0") {
    kvCoeff = 0.00003;
  }
  const kvVram = contextLength * kvCoeff;

  const totalVram = weightsVram + kvVram;

  vramEstimateTotalEl.textContent = `${totalVram.toFixed(2)} GB`;
  vramEstimateWeightsEl.textContent = `${weightsVram.toFixed(2)} GB`;
  vramEstimateKvEl.textContent = `${kvVram.toFixed(2)} GB`;

  const pct = Math.min(100, Math.round((totalVram / 12) * 100));
  vramEstimateProgressEl.style.width = `${pct}%`;
  
  if (pct >= 90) {
    vramEstimateProgressEl.className = "progress-bar-fill danger";
  } else if (pct >= 70) {
    vramEstimateProgressEl.className = "progress-bar-fill warning";
  } else {
    vramEstimateProgressEl.className = "progress-bar-fill success";
  }
}

async function executeModelLoad(e: Event) {
  e.preventDefault();
  if (!activeProfile || !selectedModelKey) return;

  const btnSubmit = document.getElementById("btn-submit-load-model") as HTMLButtonElement;
  btnSubmit.disabled = true;
  btnSubmit.textContent = "Initiating remote load...";

  const gpuRatio = parseInt(paramGpuRatioEl.value) / 100;
  const contextLength = parseInt(paramContextLengthEl.value);
  const flashAttention = paramFlashAttentionEl.checked;

  const config = {
    context_length: contextLength,
    flash_attention: flashAttention,
    offload_kv_cache_to_gpu: true,
    gpu: {
      ratio: gpuRatio
    }
  };

  hideLoadModal();

  try {
    await apiLoadModel(activeProfile.host, selectedModelKey, config);
    await connectToProfile(activeProfile);
  } catch (err: any) {
    alert("Failed to load model with custom configuration: " + err);
    await connectToProfile(activeProfile!);
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = "Initiate VRAM Load";
  }
}

// ==========================================================================
// UNIFIED HUGGING FACE DOWNLOADER HUB
// ==========================================================================
async function handleHfUnifiedSubmit(e: Event) {
  e.preventDefault();
  const input = hfUnifiedInputEl.value.trim();
  if (!input) return;

  const isRepoId = input.includes("/") && !/\s/.test(input);

  const btn = btnSubmitUnifiedEl;
  const spinner = btn.querySelector(".spinner")!;
  const btnText = btn.querySelector(".btn-text")!;

  btn.disabled = true;
  spinner.classList.remove("hidden");
  btnText.textContent = isRepoId ? "Querying..." : "Searching...";

  hfSearchResultsBoxEl.innerHTML = "";
  hfSearchResultsBoxEl.classList.add("hidden");
  quantPickerAreaEl.classList.add("hidden");

  try {
    if (isRepoId) {
      const files = await apiSearchHfRepo(input);
      renderQuantPicker(input, files);
    } else {
      const list = await apiQueryHfCatalog(input);
      renderHfSearchResults(list);
    }
  } catch (err: any) {
    alert(err.toString());
  } finally {
    btn.disabled = false;
    spinner.classList.add("hidden");
    btnText.textContent = "Query / Search";
  }
}

function getInstalledQuantsCount(repoId: string): number {
  const cleanRepo = repoId.toLowerCase().replace(/\\/g, "/");
  const repoParts = cleanRepo.split('/');
  const hfPublisher = repoParts[0];
  const hfModelSlug = repoParts[repoParts.length - 1].replace(/-gguf$/i, ""); // e.g. "meta-llama-3-8b-instruct"

  let count = 0;
  modelLibrary.forEach(m => {
    if (!m.key) return;
    const cleanStored = m.key.toLowerCase().replace(/\\/g, "/");
    
    // Normalize path by extracting portion after "models/" if present
    const pathAfterModels = cleanStored.includes("models/") ? cleanStored.split("models/")[1] : cleanStored;
    const segments = pathAfterModels.split('/');

    let storedPublisher = (m.publisher || "").toLowerCase().trim();
    let storedModelSlug = "";

    if (segments.length >= 3) {
      storedPublisher = segments[0];
      storedModelSlug = segments[1].replace(/-gguf$/i, "");
    } else if (segments.length === 2) {
      storedPublisher = segments[0];
      storedModelSlug = segments[1].replace(/-gguf$/i, "");
    } else {
      storedModelSlug = segments[0].replace(/-gguf$/i, "");
    }

    if (!storedPublisher || storedPublisher === "local store") {
      storedPublisher = (m.publisher || "").toLowerCase().trim();
    }

    const publisherMatches = storedPublisher === hfPublisher;
    const modelNameMatches = storedModelSlug.replace(/[^a-z0-9]/g, "") === hfModelSlug.replace(/[^a-z0-9]/g, "");

    if (publisherMatches && modelNameMatches) {
      count++;
    }
  });
  return count;
}

function renderHfSearchResults(list: HfSearchResult[]) {
  lastSearchResults = list;
  hfSearchResultsBoxEl.innerHTML = "";
  
  if (list.length === 0) {
    hfSearchResultsBoxEl.innerHTML = `<div class="no-results-msg">No GGUF repositories found matching your query.</div>`;
    hfSearchResultsBoxEl.classList.remove("hidden");
    return;
  }

  list.forEach(item => {
    const installedCount = getInstalledQuantsCount(item.modelId);
    
    const row = document.createElement("div");
    row.className = "hf-search-row";
    row.innerHTML = `
      <div class="hf-search-meta">
        <span class="hf-search-id" title="${escapeHtml(item.modelId)}">${escapeHtml(item.modelId)}</span>
        <div class="hf-search-stats">
          <span>⬇ ${item.downloads.toLocaleString()} downloads</span>
          <span>♥ ${item.likes.toLocaleString()} likes</span>
          ${installedCount > 0 ? `<span class="badge-stored-meta" style="color: var(--color-success); font-weight: 600; margin-left: 12px;">✓ ${installedCount} Quant${installedCount > 1 ? 's' : ''} Stored</span>` : ""}
        </div>
      </div>
      <button class="btn ${installedCount > 0 ? 'btn-success-select' : 'btn-secondary'} btn-sm btn-choose-repo">
        ${installedCount > 0 ? 'Select (Stored)' : 'Select'}
      </button>
    `;

    const btnChoose = row.querySelector(".btn-choose-repo") as HTMLButtonElement;
    btnChoose.addEventListener("click", async () => {
      hfSearchResultsBoxEl.classList.add("hidden");
      const btn = btnSubmitUnifiedEl;
      const spinner = btn.querySelector(".spinner")!;
      const btnText = btn.querySelector(".btn-text")!;
      
      btn.disabled = true;
      spinner.classList.remove("hidden");
      btnText.textContent = "Querying...";
      
      try {
        const files = await apiSearchHfRepo(item.modelId);
        renderQuantPicker(item.modelId, files);
      } catch (err: any) {
        alert("Failed to load repo files: " + err);
      } finally {
        btn.disabled = false;
        spinner.classList.add("hidden");
        btnText.textContent = "Query / Search";
      }
    });

    hfSearchResultsBoxEl.appendChild(row);
  });

  hfSearchResultsBoxEl.classList.remove("hidden");
}

function isModelInstalled(fileOptionName: string, repoId: string): boolean {
  const cleanOption = fileOptionName.toLowerCase().replace(/\.[gG][gG][uU][fF]$/, "").replace(/\\/g, "/");
  const optionParts = cleanOption.split('/');
  const optionFileName = optionParts[optionParts.length - 1]; // e.g. "gemma-2b-it-q4_k_m"
  
  // Normalize filenames by stripping out all non-alphanumeric characters (resilient to dot/hyphen/underscore variations)
  const normOptionFile = optionFileName.replace(/[^a-z0-9]/gi, "");

  // Extract quantization level from the option file name
  const optionQuantMatch = optionFileName.match(/(?:(?:Q|IQ)[0-9]_(?:K_[A-Z]+|K|[0-9_]+|[A-Z]+)|BF16|FP16|FP32)/i);
  const optionQuant = optionQuantMatch ? optionQuantMatch[0].toUpperCase() : "";

  // Extract repository name slug (e.g. "gemma-2b-instruct") and Hugging Face publisher
  const cleanRepo = repoId.toLowerCase().replace(/\\/g, "/");
  const repoParts = cleanRepo.split('/');
  const hfPublisher = repoParts[0];
  const hfModelSlug = repoParts[repoParts.length - 1].replace(/-gguf$/i, "");

  return modelLibrary.some(m => {
    if (!m.key) return false;
    const cleanStored = m.key.toLowerCase().replace(/\.[gG][gG][uU][fF]$/, "").replace(/\\/g, "/");
    const storedParts = cleanStored.split('/');
    const storedFileName = storedParts[storedParts.length - 1]; // e.g. "gemma-2b-it-q4_k_m"

    const normStoredFile = storedFileName.replace(/[^a-z0-9]/gi, "");

    // Extract quantization level from the stored model key or its structured metadata
    const storedQuantMatch = storedFileName.match(/(?:(?:Q|IQ)[0-9]_(?:K_[A-Z]+|K|[0-9_]+|[A-Z]+)|BF16|FP16|FP32)/i);
    const storedQuant = (storedQuantMatch ? storedQuantMatch[0].toUpperCase() : "") || (m.quantization?.name || "").toUpperCase();

    // 1. Exact match on normalized full key/path
    if (cleanStored === cleanOption) return true;

    // 2. Extract stored publisher and stored model slug
    const pathAfterModels = cleanStored.includes("models/") ? cleanStored.split("models/")[1] : cleanStored;
    const segments = pathAfterModels.split('/');

    let storedPublisher = (m.publisher || "").toLowerCase().trim();
    let storedModelSlug = "";

    if (segments.length >= 3) {
      storedPublisher = segments[0];
      storedModelSlug = segments[1].replace(/-gguf$/i, "");
    } else if (segments.length === 2) {
      storedPublisher = segments[0];
      storedModelSlug = segments[1].replace(/-gguf$/i, "");
    } else {
      storedModelSlug = segments[0].replace(/-gguf$/i, "");
    }

    if (!storedPublisher || storedPublisher === "local store") {
      storedPublisher = (m.publisher || "").toLowerCase().trim();
    }

    const publisherMatches = storedPublisher === hfPublisher;
    const modelNameMatches = storedModelSlug.replace(/[^a-z0-9]/g, "") === hfModelSlug.replace(/[^a-z0-9]/g, "");
    const quantMatches = storedQuant === optionQuant;

    // 3. Match if publisher, model family, and quantization all match perfectly
    if (publisherMatches && modelNameMatches && quantMatches) {
      return true;
    }

    // 4. Exact match on normalized base file name (highly robust)
    if (normStoredFile === normOptionFile) {
      if (!storedPublisher || storedPublisher === "local store" || publisherMatches) {
        return true;
      }
    }
    
    // 5. Match on path matching publisher + repo + file name
    const expectedPath = `${repoId.toLowerCase()}/${cleanOption}`.replace(/\\/g, "/");
    if (cleanStored === expectedPath) return true;

    return false;
  });
}

function renderQuantPicker(repoId: string, files: GgufFileOption[]) {
  lastSelectedRepoId = repoId;
  lastQuantFiles = files;
  quantFilesListEl.innerHTML = "";
  quantPickerRepoTitleEl.textContent = `Repository: ${repoId}`;
  
  if (files.length === 0) {
    quantFilesListEl.innerHTML = `<div class="no-results-msg">No GGUF files found in this repository.</div>`;
    quantPickerAreaEl.classList.remove("hidden");
    return;
  }

  files.forEach(file => {
    const sizeStr = (file.size_bytes / (1024*1024*1024)).toFixed(2) + " GB";
    const isAlreadyStored = isModelInstalled(file.name, repoId);

    const row = document.createElement("div");
    row.className = "quant-row";
    row.innerHTML = `
      <div class="quant-name-cell" title="${escapeHtml(file.name)}">
        ${escapeHtml(file.name)}
        ${file.recommended ? `<span class="badge-recommended">Recommended</span>` : ""}
        ${isAlreadyStored ? `<span class="badge-stored">✓ Installed</span>` : ""}
      </div>
      <div class="quant-size-cell">${sizeStr}</div>
      <div>
        <button class="btn btn-accent btn-sm btn-download-quant" data-name="${file.name}">Download</button>
      </div>
    `;

    const btnDownload = row.querySelector(".btn-download-quant") as HTMLButtonElement;
    
    if (isAlreadyStored) {
      btnDownload.disabled = true;
      btnDownload.textContent = "In Library";
      btnDownload.title = "This model GGUF file is already present in your remote LM Studio library.";
      btnDownload.classList.remove("btn-accent");
      btnDownload.classList.add("btn-success");
    } else if (!isConnected) {
      btnDownload.disabled = true;
      btnDownload.textContent = "Offline";
      btnDownload.title = "Connect to an LM Studio server profile first to download remote models.";
      btnDownload.classList.remove("btn-accent");
      btnDownload.classList.add("btn-secondary");
    } else {
      btnDownload.addEventListener("click", async () => {
        btnDownload.disabled = true;
        btnDownload.textContent = "Starting...";
        await triggerModelDownload(repoId, file.name);
      });
    }

    quantFilesListEl.appendChild(row);
  });

  quantPickerAreaEl.classList.remove("hidden");
}

async function triggerModelDownload(repoId: string, filename: string) {
  if (!activeProfile) {
    alert("No active server connected.");
    return;
  }

  // Parse quantization level from filename
  const quantMatch = filename.match(/(?:(?:Q|IQ)[0-9]_(?:K_[A-Z]+|K|[0-9_]+|[A-Z]+)|BF16|FP16|FP32)/i);
  const quantization = quantMatch ? quantMatch[0].toUpperCase() : undefined;

  // Standardize model identifier to direct Hugging Face link so LM Studio parses it correctly
  let modelIdentifier = repoId.trim();
  if (!modelIdentifier.startsWith("http://") && !modelIdentifier.startsWith("https://")) {
    modelIdentifier = `https://huggingface.co/${modelIdentifier}`;
  }

  try {
    const res = await apiDownloadModel(activeProfile.host, modelIdentifier, quantization);
    if (res && res.job_id) {
      const jobId = res.job_id;
      activeDownloadsMap.set(jobId, { repoId, filename });
      downloadsTrackerSectionEl.classList.remove("hidden");
      await pollDownloadJobs();
    } else {
      alert("Download triggered, but no active job ID was returned. Check LM Studio's manual download queues.");
    }
  } catch (err: any) {
    alert("Failed to start remote download: " + err);
  }
}

// ==========================================================================
// BACKGROUND REMOTE DOWNLOAD POLLING
// ==========================================================================
function startPollingDownloads() {
  if (pollTimerId) clearInterval(pollTimerId);
  pollTimerId = setInterval(async () => {
    if (activeDownloadsMap.size > 0 && activeProfile) {
      await pollDownloadJobs();
    }
  }, 2500);
}

async function pollDownloadJobs() {
  if (!activeProfile) return;
  
  const jobIds = Array.from(activeDownloadsMap.keys());
  
  // Show orange notify dot on Downloader Tab if background downloads are active
  if (jobIds.length > 0) {
    downloadActiveDotEl.classList.remove("hidden");
  } else {
    downloadActiveDotEl.classList.add("hidden");
  }

  downloadsListEl.innerHTML = "";

  for (const jobId of jobIds) {
    const details = activeDownloadsMap.get(jobId)!;
    
    try {
      const status = await apiGetDownloadStatus(activeProfile.host, jobId);
      if (!status) continue;

      // Successful poll: reset consecutive error count
      downloadConsecutiveErrorsMap.set(jobId, 0);

      // Support camelCase / snake_case fallbacks and alternative schemas
      const currentStatus = status.status || (status as any).state || "downloading";
      const totalBytes = status.total_size_bytes || (status as any).totalSizeBytes || (status as any).total_bytes || (status as any).totalBytes || 0;
      const downloadedBytes = status.downloaded_bytes || (status as any).downloadedBytes || 0;
      const bytesPerSec = status.bytes_per_second || (status as any).bytesPerSecond || (status as any).speed || 0;
      const eta = status.estimated_completion || (status as any).estimatedCompletion || "Calculating ETA...";
      
      const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      const speedMB = (bytesPerSec / (1024*1024)).toFixed(1) + " MB/s";

      // Convert raw ISO 8601 estimated completion timestamp into a premium human-friendly countdown
      let etaStr = "Calculating ETA...";
      if (eta && eta !== "Calculating ETA...") {
        const targetDate = new Date(eta);
        if (!isNaN(targetDate.getTime())) {
          const diffMs = targetDate.getTime() - Date.now();
          if (diffMs > 0) {
            const diffSecs = Math.round(diffMs / 1000);
            if (diffSecs < 60) {
              etaStr = `${diffSecs}s remaining`;
            } else {
              const mins = Math.floor(diffSecs / 60);
              const secs = diffSecs % 60;
              etaStr = `${mins}m ${secs}s remaining`;
            }
          } else {
            etaStr = "Finishing...";
          }
        } else {
          etaStr = eta.toString();
        }
      }

      if (currentStatus === "completed" || currentStatus === "already_downloaded") {
        activeDownloadsMap.delete(jobId);
        downloadConsecutiveErrorsMap.delete(jobId);
        alert(`Download completed successfully: ${details.filename}`);
        await connectToProfile(activeProfile);
        continue;
      }
      
      if (currentStatus === "failed") {
        activeDownloadsMap.delete(jobId);
        downloadConsecutiveErrorsMap.delete(jobId);
        alert(`Download failed: ${details.filename}`);
        continue;
      }

      const displayStatus = currentStatus.toString().toUpperCase();

      const card = document.createElement("div");
      card.className = "download-card";
      card.innerHTML = `
        <div class="download-card-meta">
          <div class="download-title">
            <h4>${escapeHtml(details.filename)}</h4>
            <p>${escapeHtml(details.repoId)} • Status: ${escapeHtml(displayStatus)}</p>
          </div>
          <span class="download-pct">${pct}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="download-telemetry-row">
          <span>Speed: <strong class="download-speed">${speedMB}</strong></span>
          <span class="download-eta">${escapeHtml(etaStr)}</span>
        </div>
      `;
      
      downloadsListEl.appendChild(card);

    } catch (err: any) {
      console.error(`Failed to poll job ${jobId}:`, err);
      const consecutiveErrors = (downloadConsecutiveErrorsMap.get(jobId) || 0) + 1;
      downloadConsecutiveErrorsMap.set(jobId, consecutiveErrors);

      // Only prune/delete tracking if we get persistent consecutive 404 errors (indicates dead job, not startup delay)
      if (consecutiveErrors >= 5) {
        const errStr = err.toString();
        if (errStr.includes("404") || errStr.includes("Not Found") || errStr.includes("HTTP 404")) {
          activeDownloadsMap.delete(jobId);
          downloadConsecutiveErrorsMap.delete(jobId);
        }
      }
    }
  }

  if (activeDownloadsMap.size === 0) {
    downloadsTrackerSectionEl.classList.add("hidden");
    downloadActiveDotEl.classList.add("hidden");
  } else {
    downloadsTrackerSectionEl.classList.remove("hidden");
  }
}

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/&amp;amp;/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
