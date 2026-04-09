// Firebase Imports
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot, getDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

// Firebase Configuration & Initialization
const firebaseConfig = {
  apiKey: "AIzaSyCUOqjWShuit2xWcwNpSewrsdX2eTBP4UE",
  authDomain: "p01---entrega-de-docs.firebaseapp.com",
  projectId: "p01---entrega-de-docs",
  storageBucket: "p01---entrega-de-docs.firebasestorage.app",
  messagingSenderId: "633630915261",
  appId: "1:633630915261:web:77f594fd31eaeefbf595d4",
  measurementId: "G-008K7RTHVP"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const GLOBAL_DOC_PATH = "apf_data/v2_global_state";

// Data Models & State Initialization
let dbx = null;
const DEFAULT_ITEMS = [
    { id: 'sec1', name: 'Legalização', parentId: null, protected: true, expanded: false, attachments: [] },
    { id: 'sec2', name: 'Arquitetura e Urbanismo', parentId: null, protected: true, expanded: false, attachments: [] },
    { id: 'sec3', name: 'Engenharia', parentId: null, protected: true, expanded: false, attachments: [] },
    { id: 'sec4', name: 'Sustentabilidade', parentId: null, protected: true, expanded: false, attachments: [] }
];

let state = {
    projects: [
        { id: 'p_default', name: 'Modelo de Entrega', items: JSON.parse(JSON.stringify(DEFAULT_ITEMS)), dueDate: '', createdAt: new Date().toISOString().split('T')[0], engAnalysisOpened: false, pendencias: [], pendenciaStartDate: '' }
    ],
    settings: {
        sectorPasswords: { "APF": "1234" } // Senha padrão inicial
    },
    auditLog: []
};
let isAuthenticated = false;
let authenticatedSector = null;
let editingPendenciaId = null;
let isInitialCloudLoad = true;

// UI State (Local-only, per device/browser)
let localUI = {
    expandedIds: new Set(),
    showFullChecklistDuringPendencia: false,
    currentProjectId: null
};
let treeSearchQuery = '';
let treeSearchFilter = 'all'; // all, pendente, apontamento

function loadLocalUI() {
    try {
        const saved = localStorage.getItem('apf_local_ui_v1');
        if (saved) {
            const parsed = JSON.parse(saved);
            localUI.expandedIds = new Set(parsed.expandedIds || []);
            localUI.showFullChecklistDuringPendencia = parsed.showFullChecklistDuringPendencia || false;
            localUI.currentProjectId = parsed.currentProjectId || null;
        }
    } catch (e) { console.warn("Erro ao carregar IU local", e); }
}

function saveLocalUI() {
    const toSave = {
        expandedIds: Array.from(localUI.expandedIds),
        showFullChecklistDuringPendencia: localUI.showFullChecklistDuringPendencia,
        currentProjectId: localUI.currentProjectId
    };
    localStorage.setItem('apf_local_ui_v1', JSON.stringify(toSave));
    localStorage.setItem('apf_last_project_id', localUI.currentProjectId); // Backwards compat
}



// Helpers
function generateId() { return Math.random().toString(36).substr(2, 9); }
function getCurrentProject() { return state.projects.find(p => p.id === localUI.currentProjectId); }
function getItems() { return getCurrentProject()?.items || []; }
function isMgmtActive() {
    const activeTabObj = Array.from(tabs).find(t => t.classList.contains('active'));
    return activeTabObj && activeTabObj.dataset.tab === 'management';
}

function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Persistence
const CACHE_KEY = 'apf_global_state_cache_v2';

async function loadState() {
    // 1. First, check if there's local cache for instant load
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
        try {
            state = JSON.parse(cached);
            console.log("Loaded from local cache.");
            renderAfterUpdate();
        } catch(e) { console.warn("Cache error", e); }
    }

    // 2. Setup Silent Cloud Load
    await syncWithCloud();
}

async function syncWithCloud() {
    const docRef = doc(db, GLOBAL_DOC_PATH);
    try {
        const snapshot = await getDoc(docRef);
        if (snapshot.exists()) {
            const cloudData = snapshot.data();
            console.log("Cloud data fetched:", cloudData);
            
            // Basic Migrations
            for (const p of cloudData.projects) {
                if (!p.createdAt) p.createdAt = new Date().toISOString().split('T')[0];
                if (p.engAnalysisOpened === undefined) p.engAnalysisOpened = false;
                if (!p.pendencias) p.pendencias = [];
            }
            
            if (!cloudData.settings) cloudData.settings = {};
            if (!cloudData.settings.sectorPasswords) cloudData.settings.sectorPasswords = { "APF": "1234" };

            state = cloudData;
            localStorage.setItem(CACHE_KEY, JSON.stringify(state)); // Update cache
            
            if (isInitialCloudLoad) {
                isInitialCloudLoad = false;
                if (!state.projects.find(p => p.id === localUI.currentProjectId)) {
                    localUI.currentProjectId = null;
                }
            }

            renderAfterUpdate();
        } else {
            // Check for legacy migration
            const localSaved = localStorage.getItem('apf_checklist_v2.2');
            if (localSaved && isInitialCloudLoad) {
                console.log("Migrating legacy data...");
                state = JSON.parse(localSaved);
                isInitialCloudLoad = false;
                saveState();
            } else if (isInitialCloudLoad) {
                console.log("Starting default state.");
                isInitialCloudLoad = false;
                saveState();
            }
        }
    } catch(e) {
        console.error("Cloud sync error:", e);
    }
}

function renderAfterUpdate() {
    updateGlobalDateUI();
    renderTree();
    renderTracking();
    updateThemeIcon();
    renderAuditLog();
}

let saveTimeout = null;
function saveState() {
    // Save structure to Firestore (Debounced to avoid rapid writes)
    if (saveTimeout) clearTimeout(saveTimeout);
    
    saveTimeout = setTimeout(async () => {
        const docRef = doc(db, GLOBAL_DOC_PATH);
        const saveableState = {
            projects: state.projects.map(p => {
                // Pre-calculate stats for the project before saving
                const stats = p.id !== 'p_default' ? calculateProjectStats(p) : { pendente: 0, apontamento: 0 };
                
                return {
                    ...p,
                    stats, // Save pre-calculated stats
                    engAnalysisOpened: p.engAnalysisOpened || false,
                    pendenciaActive: p.pendenciaActive || false,
                    pendencias: (p.pendencias || []).map(pend => ({
                        id: pend.id,
                        docName: pend.docName,
                        sector: pend.sector,
                        specification: pend.specification || '',
                        attachments: (pend.attachments || []).map(att => ({
                            ...att,
                            dropboxPath: att.dropboxPath || '',
                            dropboxUrl: att.dropboxUrl || '',
                            storagePath: att.storagePath || '',
                            downloadUrl: att.downloadUrl || '',
                            objectUrl: att.downloadUrl || att.dropboxUrl || att.objectUrl || '',
                            source: att.source || ''
                        })),
                        observation: pend.observation || ''
                    })),
                    pendenciaStartDate: p.pendenciaStartDate || '',
                    items: p.items.map(item => {
                        const { expanded, ...rest } = item;
                        return {
                            ...rest,
                            attachments: (item.attachments || []).map(att => ({
                                ...att,
                                dropboxPath: att.dropboxPath || '',
                                dropboxUrl: att.dropboxUrl || '',
                                storagePath: att.storagePath || '',
                                downloadUrl: att.downloadUrl || '',
                                objectUrl: att.downloadUrl || att.dropboxUrl || att.objectUrl || '',
                                source: att.source || ''
                            }))
                        };
                    })
                };
            }),
            auditLog: state.auditLog || []
        };
        
        // Update Local Cache Immediately
        localStorage.setItem(CACHE_KEY, JSON.stringify(saveableState));

        try {
            await setDoc(docRef, saveableState);
            console.log("State synced to cloud & cache.");
        } catch (e) {
            console.error("Error syncing to cloud:", e);
        }
    }, 500); // 500ms debounce
}

function calculateProjectStats(project) {
    let pendente = 0;
    let apontamento = 0;
    
    project.items.forEach(item => {
        const hasChildren = project.items.some(child => child.parentId === item.id);
        if (item.parentId !== null && !hasChildren) {
            if(!item.isNotApplicable && (!item.attachments || item.attachments.length === 0)) {
                pendente++;
            }
            if(item.validationStatus === 'Apontamento') {
                apontamento++;
            }
        }
    });
    
    return { pendente, apontamento };
}

function getItemSector(itemId) {
    const items = getItems();
    if (!items) return null;
    let curr = items.find(i => i.id === itemId);
    while (curr && curr.parentId !== null) {
        let parent = items.find(i => i.id === curr.parentId);
        if (!parent) break;
        curr = parent;
    }
    return curr ? curr.name : null;
}

function updateThemeIcon() {
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) {
        if (document.documentElement.classList.contains('light-mode')) {
            themeBtn.innerHTML = '<i class="ph ph-moon"></i>';
        } else {
            themeBtn.innerHTML = '<i class="ph ph-sun"></i>';
        }
    }
}

// DOM Elements
let btnNewProject, btnExportZip, btnToggleEng, btnDeleteProject, btnRenameProject, btnOpenTemplate, btnAddRoot;
let checklistContainer, sidebarApf, btnToggleSidebar, managementContainer, trackingContainer;
let tabs, tabContents, btnUnlock, btnBackToMain, inputPassword, passwordError, passwordLock, managementContent;
let btnSettings, btnSaveSettings, btnResetModel, geminiModelInp, geminiKeyInp, btnToggleKey, dbxKeyInp, apfPassInp;
let btnTogglePendencias, pendenciasMgmtPanel, btnAddPendencia, pendenciaStartDateInp, modalOverlay, btnCloseModal;
let btnShowHistory, historyModal, btnCloseHistory;
let projectDueDateInp, currentProjectName, projectGlobalCountdown;
let globalLogin, loginSector;
let btnLogout, authStatusBanner;

function initDOMElements() {
    // Auth
    globalLogin = document.getElementById('global-login');
    loginSector = document.getElementById('login-sector');
    btnLogout = document.getElementById('btn-logout');
    authStatusBanner = document.getElementById('auth-status-banner');

    // Buttons
    btnNewProject = document.getElementById('btn-new-project');
    btnExportZip = document.getElementById('btn-export-zip');
    btnToggleEng = document.getElementById('btn-toggle-eng');
    btnDeleteProject = document.getElementById('btn-delete-project');
    btnRenameProject = document.getElementById('btn-rename-project');
    btnOpenTemplate = document.getElementById('btn-open-template');
    btnAddRoot = document.getElementById('btn-add-root');
    
    // Containers
    checklistContainer = document.getElementById('checklist-render-area');
    sidebarApf = document.getElementById('sidebar-apf');
    btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    managementContainer = document.getElementById('management-render-area');
    trackingContainer = document.getElementById('tracking-render-area');

    // Tabs & Management
    tabs = document.querySelectorAll('.tab-btn');
    tabContents = document.querySelectorAll('.tab-content');
    btnUnlock = document.getElementById('btn-unlock');
    inputPassword = document.getElementById('global-password-input');
    passwordError = document.getElementById('global-password-error');
    passwordLock = document.getElementById('password-lock');
    managementContent = document.getElementById('management-content');

    // Pendencias & Modals
    btnTogglePendencias = document.getElementById('btn-toggle-pendencias');
    pendenciasMgmtPanel = document.getElementById('pendencias-mgmt-panel');
    btnAddPendencia = document.getElementById('btn-add-pendencia');
    pendenciaStartDateInp = document.getElementById('pendencia-start-date');
    modalOverlay = document.getElementById('modal-overlay');
    btnCloseModal = document.getElementById('btn-close-modal');

    // Inputs
    projectDueDateInp = document.getElementById('project-due-date');
    currentProjectName = document.getElementById('current-project-name');
    projectGlobalCountdown = document.getElementById('project-global-countdown');

    // History Modal
    btnShowHistory = document.getElementById('btn-show-history');
    historyModal = document.getElementById('history-modal');
    btnCloseHistory = document.getElementById('btn-close-history');
    
    // Audit Log
    const btnClearLogs = document.getElementById('btn-clear-logs');
    if (btnClearLogs) {
        btnClearLogs.onclick = () => {
            if (confirm('Tem certeza que deseja limpar permanentemente o histórico de ações?')) {
                state.auditLog = [];
                saveState();
                renderAuditLog();
            }
        };
    }
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    initDOMElements();
    loadLocalUI(); // Carrega IU local (pastas abertas, etc)
    
    // Theme setup
    if (localStorage.getItem('apf_theme') === 'light') {
        document.documentElement.classList.add('light-mode');
        const themeBtn = document.getElementById('btn-theme-toggle');
        if (themeBtn) themeBtn.innerHTML = '<i class="ph ph-moon"></i>';
    }

    initEventListeners();
    initDropbox();
    await loadState(); 
    
    // Check session after state is loaded (to populate sectors)
    applyAuthState();
    
    initAIEngine();
    initSettings();
});

function initEventListeners() {
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    if (btnThemeToggle) {
        btnThemeToggle.addEventListener('click', () => {
            const htmlEl = document.documentElement;
            htmlEl.classList.toggle('light-mode');
            if (htmlEl.classList.contains('light-mode')) {
                localStorage.setItem('apf_theme', 'light');
                btnThemeToggle.innerHTML = '<i class="ph ph-moon"></i>';
            } else {
                localStorage.setItem('apf_theme', 'dark');
                btnThemeToggle.innerHTML = '<i class="ph ph-sun"></i>';
            }
        });
    }
    
    // Authenticate events
    if (btnUnlock) {
        btnUnlock.addEventListener('click', () => {
            const sector = loginSector.value;
            const password = inputPassword.value;
            
            if (!sector) {
                alert("Por favor, selecione um setor.");
                return;
            }

            const storedPasswords = state.settings?.sectorPasswords || {};
            const correctPassword = storedPasswords[sector] || "1234"; // Default fallback to 1234
            
            if(password === correctPassword) {
                isAuthenticated = true;
                authenticatedSector = sector;
                inputPassword.value = '';
                passwordError.style.display = 'none';
                
                // Salvar sessão temporária no sessionStorage
                sessionStorage.setItem('apf_session_sector', sector);
                
                applyAuthState();
                renderTree();
                populateLoginSectors(); // Update if needed
            } else {
                passwordError.style.display = 'block';
                inputPassword.style.borderColor = 'var(--danger)';
                setTimeout(() => {
                    inputPassword.style.borderColor = '';
                }, 1000);
            }
        });
    }

    if (inputPassword) {
        inputPassword.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') btnUnlock.click();
        });
    }

    if (btnLogout) {
        btnLogout.addEventListener('click', logout);
    }

    // Tab Navigation initialization
    if (tabs) {
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // If not APF, cannot access management tab
                if (tab.dataset.tab === 'management' && authenticatedSector !== 'APF') {
                    showTemporaryMessage("Acesso restrito ao perfil APF.");
                    return;
                }
                const alreadyActive = tab.classList.contains('active');

                if (alreadyActive) {
                    tab.classList.remove('active');
                    if (tab.dataset.tab === 'management') {
                        isAuthenticated = false;
                        if (inputPassword) inputPassword.value = '';
                    }
                    tabContents.forEach(tc => tc.classList.remove('active'));
                    const checklistSection = document.getElementById('tab-checklist');
                    if (checklistSection) checklistSection.style.display = '';
                    applyAuthState();
                    updateGlobalDateUI();
                    renderTree();
                    renderTracking();
                    return;
                }

                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                tabContents.forEach(tc => tc.classList.remove('active'));
                const targetContent = document.getElementById(`tab-${tab.dataset.tab}`);
                if (targetContent) targetContent.classList.add('active');

                const checklistSection = document.getElementById('tab-checklist');
                if (checklistSection) {
                    checklistSection.style.display = tab.dataset.tab === 'management' ? 'none' : '';
                }

                applyAuthState();
                updateGlobalDateUI();
                renderTree();
                renderTracking();
            });
        });
    }

    // Sidebar & Project Management Listeners
    if (projectDueDateInp) {
        projectDueDateInp.addEventListener('change', (e) => {
            const curr = getCurrentProject();
            if(curr && curr.id !== 'p_default') {
                curr.dueDate = e.target.value;
                saveState();
                updateGlobalDateUI();
                renderTracking();
            }
        });
    }

    if (btnNewProject) {
        btnNewProject.addEventListener('click', () => {
            const name = prompt('Nome do novo empreendimento (que herdará as pastas do Modelo de Entrega):');
            if(name && name.trim()){
                const baseProj = state.projects.find(p => p.id === 'p_default') || state.projects[0];
                const duplicatedItems = JSON.parse(JSON.stringify(baseProj.items)).map(item => {
                    item.attachments = [];
                    item.validationStatus = 'Em Análise';
                    item.observation = '';
                    item.expanded = false;
                    return item;
                });
                const newProj = {
                    id: 'p_' + generateId(),
                    name: name.trim(),
                    dueDate: '',
                    engAnalysisOpened: false,
                    createdAt: new Date().toISOString().split('T')[0],
                    pendenciaActive: false,
                    pendencias: [],
                    items: duplicatedItems
                };
                state.projects.push(newProj);
                localUI.currentProjectId = newProj.id;
                saveLocalUI();
                saveState();
                updateGlobalDateUI();
                renderTree();
                renderTracking();
                tabs.forEach(t => t.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                document.querySelector('[data-tab="management"]').classList.add('active');
                document.getElementById('tab-management').classList.add('active');
                applyAuthState();
            }
        });
    }

    if (btnExportZip) {
        btnExportZip.addEventListener('click', async () => {
            const curr = getCurrentProject();
            if (!curr || curr.id === 'none') {
                alert('Selecione um empreendimento primeiro.');
                return;
            }
            const originalBtnContent = btnExportZip.innerHTML;
            btnExportZip.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Gerando ZIP...';
            btnExportZip.disabled = true;
            try {
                const zip = new JSZip();
                const rootFolder = zip.folder(curr.name);
                async function processItem(item, folder) {
                    const children = getItems().filter(i => i.parentId === item.id);
                    const itemFolder = folder.folder(item.name);
                    if (item.attachments && item.attachments.length > 0) {
                        for (const att of item.attachments) {
                            try {
                                const response = await fetch(att.objectUrl);
                                const blob = await response.blob();
                                itemFolder.file(att.name, blob);
                            } catch (e) { console.error(`Erro ao baixar arquivo ${att.name}:`, e); }
                        }
                    }
                    for (const child of children) { await processItem(child, itemFolder); }
                }
                const roots = getChildItems(null);
                if (roots.length === 0) {
                    alert('Não há itens para exportar.');
                    btnExportZip.innerHTML = originalBtnContent;
                    btnExportZip.disabled = false;
                    return;
                }
                for (const root of roots) { await processItem(root, rootFolder); }
                const content = await zip.generateAsync({ type: 'blob' });
                const zipUrl = URL.createObjectURL(content);
                const link = document.createElement('a');
                link.href = zipUrl;
                link.download = `${curr.name}_Export.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(zipUrl);
            } catch (error) {
                console.error('Erro na exportação ZIP:', error);
                alert('Ocorreu um erro ao gerar o arquivo ZIP.');
            } finally {
                btnExportZip.innerHTML = originalBtnContent;
                btnExportZip.disabled = false;
            }
        });
    }

    if (btnToggleEng) {
        btnToggleEng.addEventListener('click', () => {
            const curr = getCurrentProject();
            if (curr && curr.id !== 'p_default') {
                curr.engAnalysisOpened = !curr.engAnalysisOpened;
                saveState();
                updateGlobalDateUI();
                renderTracking();
            }
        });
    }

    if (btnDeleteProject) {
        btnDeleteProject.addEventListener('click', () => {
            const curr = getCurrentProject();
            if (localUI.currentProjectId === 'p_default') {
                alert("Não é possível excluir o Modelo de Entrega.");
                return;
            }
            if (confirm(`Tem certeza que deseja excluir o empreendimento "${curr.name}"?`)) {
                const nextProj = state.projects.find(p => p.id !== localUI.currentProjectId) || state.projects[0];
                state.projects = state.projects.filter(p => p.id !== localUI.currentProjectId);
                localUI.currentProjectId = nextProj.id;
                saveLocalUI();
                saveState();
                updateGlobalDateUI();
                renderTree();
                renderTracking();
            }
        });
    }

    if (btnRenameProject) {
        btnRenameProject.addEventListener('click', () => {
            const curr = getCurrentProject();
            if (curr.id === 'p_default') return;
            const newName = prompt('Novo nome para o empreendimento:', curr.name);
            if (newName && newName.trim() && newName.trim() !== curr.name) {
                curr.name = newName.trim();
                saveState();
                updateGlobalDateUI();
                renderTree();
                renderTracking();
            }
        });
    }

    if (btnOpenTemplate) {
        btnOpenTemplate.onclick = () => {
            if(localUI.currentProjectId === 'p_default') return;
            localUI.currentProjectId = 'p_default';
            localUI.expandedIds.clear(); // Ocultar pastas por padrão ao abrir o modelo
            saveLocalUI();
            updateGlobalDateUI();
            renderTree();
            renderTracking();
            triggerPanelAnimation();
        };
    }

    if (btnAddRoot) {
        btnAddRoot.addEventListener('click', () => handleAddFolder(null));
    }

    // Toggle All logic
    const btnToggleAllChecklist = document.getElementById('btn-toggle-all-checklist');
    const btnToggleAllMgmt = document.getElementById('btn-toggle-all-mgmt');

    const handleToggleAll = (btn) => {
        const p = getCurrentProject();
        if(!p) return;

        const isExpanding = btn.querySelector('.label').textContent.includes('Mostrar');
        
        p.items.forEach(item => {
            const hasChildren = p.items.some(child => child.parentId === item.id);
            if (hasChildren) {
                if (isExpanding) {
                    localUI.expandedIds.add(item.id);
                } else {
                    localUI.expandedIds.delete(item.id);
                }
            }
        });

        saveLocalUI();
        renderTree();
    };

    if (btnToggleAllChecklist) btnToggleAllChecklist.onclick = () => handleToggleAll(btnToggleAllChecklist);
    if (btnToggleAllMgmt) btnToggleAllMgmt.onclick = () => handleToggleAll(btnToggleAllMgmt);

    if (btnTogglePendencias) {
        btnTogglePendencias.onclick = () => {
            const curr = getCurrentProject();
            if (!curr || curr.id === 'p_default') {
                alert('Selecione um empreendimento para gerenciar pendências.');
                return;
            }
            curr.pendenciaActive = !curr.pendenciaActive;
            saveState();
            renderTree();
            renderTracking();
            
            if (curr.pendenciaActive) {
                setTimeout(() => {
                    const panel = document.getElementById('pendencias-mgmt-panel');
                    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 150);
            }
        };
    }

    if (pendenciaStartDateInp) {
        pendenciaStartDateInp.onchange = (e) => {
            const curr = getCurrentProject();
            if (curr) {
                curr.pendenciaStartDate = e.target.value;
                saveState();
                renderTracking();
            }
        };
    }

    if (btnAddPendencia) {
        btnAddPendencia.onclick = () => {
            const nameInp = document.getElementById('new-pendencia-name');
            const sectorSel = document.getElementById('new-pendencia-sector');
            const sectorOtherInp = document.getElementById('new-pendencia-sector-other');
            const specInp = document.getElementById('new-pendencia-spec');
            const name = nameInp.value.trim();
            const specValue = sectorSel.value;
            const sector = specValue === 'other' ? sectorOtherInp.value.trim() : specValue;
            const specification = specInp.value.trim();
            if (!name || !sector) {
                alert('Preencha o nome do documento e selecione o setor.');
                return;
            }
            const curr = getCurrentProject();
            if (curr) {
                if (!curr.pendencias) curr.pendencias = [];
                if (editingPendenciaId) {
                    const pend = curr.pendencias.find(p => p.id === editingPendenciaId);
                    if (pend) {
                        pend.docName = name;
                        pend.sector = sector;
                        pend.specification = specification;
                    }
                    editingPendenciaId = null;
                    btnAddPendencia.innerHTML = '<i class="ph ph-plus"></i> Adicionar';
                    btnAddPendencia.classList.remove('btn-warning');
                    btnAddPendencia.classList.add('btn-danger');
                } else {
                    curr.pendencias.push({
                        id: generateId(), docName: name, sector: sector, specification: specification, attachments: [], observation: ''
                    });
                }
                nameInp.value = '';
                sectorSel.value = '';
                sectorOtherInp.value = '';
                sectorOtherInp.classList.add('hidden');
                specInp.value = '';
                saveState();
                renderPendenciasMgmt();
                renderTree();
            }
        };
    }

    const pendenciaSectorSel = document.getElementById('new-pendencia-sector');
    if (pendenciaSectorSel) {
        pendenciaSectorSel.onchange = (e) => {
            const other = document.getElementById('new-pendencia-sector-other');
            if (e.target.value === 'other') { other.classList.remove('hidden'); } else { other.classList.add('hidden'); }
        };
    }

    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', () => modalOverlay.classList.add('hidden'));
    }
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => { if(e.target === modalOverlay) modalOverlay.classList.add('hidden'); });
    }

    // Global Search Events
    const searchInp = document.getElementById('global-tree-search');
    const btnClearSearch = document.getElementById('btn-clear-search');

    if (searchInp) {
        searchInp.addEventListener('input', (e) => {
            treeSearchQuery = e.target.value.toLowerCase();
            if (btnClearSearch) btnClearSearch.style.display = treeSearchQuery.length > 0 ? 'flex' : 'none';
            if (treeSearchQuery.length > 0 || treeSearchFilter !== 'all') expandRelevantNodes();
            renderTree();
        });
    }

    if (btnClearSearch) {
        btnClearSearch.onclick = () => {
            searchInp.value = '';
            treeSearchQuery = '';
            btnClearSearch.style.display = 'none';
            renderTree();
        };
    }

    const filterChips = document.querySelectorAll('.filter-chip');
    filterChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const filter = chip.dataset.filter;
            filterChips.forEach(c => {
                if (c.dataset.filter === filter) {
                    c.classList.add('active');
                } else {
                    c.classList.remove('active');
                }
            });
            treeSearchFilter = filter;
            if (treeSearchFilter !== 'all' || treeSearchQuery !== '') expandRelevantNodes();
            renderTree();
        });
    });
}

const btnDbx = document.getElementById('btn-connect-dropbox');
// Authentication - Dropbox
async function initDropbox() {
    const hash = window.location.hash;
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const dropboxAppKey = localStorage.getItem('apf_dropbox_app_key');
    
    let token = localStorage.getItem('apf_dropbox_token');
    let refreshToken = localStorage.getItem('apf_dropbox_refresh_token');

    // NEW: Handle authorization code from redirect (Offline flow)
    if (code) {
        const codeVerifier = localStorage.getItem('apf_dropbox_verifier');
        if (codeVerifier && dropboxAppKey) {
            try {
                let cleanPath = window.location.pathname.replace(/\/index\.html$/, '/');
                if (!cleanPath.endsWith('/')) cleanPath += '/';
                const redirectUri = window.location.origin + cleanPath;

                const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        code: code,
                        grant_type: 'authorization_code',
                        client_id: dropboxAppKey,
                        code_verifier: codeVerifier,
                        redirect_uri: redirectUri
                    })
                });

                const data = await response.json();
                if (data.access_token) {
                    token = data.access_token;
                    refreshToken = data.refresh_token; 
                    localStorage.setItem('apf_dropbox_token', token);
                    if (refreshToken) localStorage.setItem('apf_dropbox_refresh_token', refreshToken);
                    
                    // Cleanup URL and verifier
                    localStorage.removeItem('apf_dropbox_verifier');
                    window.history.replaceState({}, document.title, window.location.pathname);
                }
            } catch (err) {
                console.error("Erro na troca do token Dropbox:", err);
            }
        }
    }

    // Support access_token in hash (previous implicit flow)
    if (hash && hash.includes('access_token')) {
        const params = new URLSearchParams(hash.substring(1));
        token = params.get('access_token');
        if (token) {
            localStorage.setItem('apf_dropbox_token', token);
            window.location.hash = ''; 
        }
    }
    
    if (token || refreshToken) {
        // Initialize with refreshToken to allow automatic renewal
        dbx = new window.Dropbox.Dropbox({ 
            accessToken: token,
            refreshToken: refreshToken,
            clientId: dropboxAppKey
        });
        
        if(btnDbx) {
            btnDbx.innerHTML = '<i class="ph ph-check-circle"></i>';
            btnDbx.title = 'Dropbox Conectado (Permanente)';
            btnDbx.classList.remove('btn-outline');
            btnDbx.classList.add('glass-panel');
            btnDbx.style.color = 'var(--accent)';
            btnDbx.style.border = '1px solid var(--accent)';
            btnDbx.onclick = () => {
                if(confirm('Deseja desconectar sua conta do Dropbox?')) {
                    localStorage.removeItem('apf_dropbox_token');
                    localStorage.removeItem('apf_dropbox_refresh_token');
                    location.reload();
                }
            };
        }
    } else {
        if(btnDbx) {
            btnDbx.onclick = async () => {
                if (!dropboxAppKey) {
                    alert("Configuração Pendente: Por favor, insira sua 'Dropbox App Key' nas Configurações (ícone ⚙️) para habilitar a conexão.");
                    return;
                }

                if (window.location.protocol === 'file:') {
                    alert("O Dropbox não permite login de arquivos locais (file://). Use o servidor local.");
                    return;
                }

                // PKCE Flow
                const array = new Uint8Array(32);
                window.crypto.getRandomValues(array);
                const verifier = Array.from(array, b => ("00" + b.toString(16)).slice(-2)).join('');
                localStorage.setItem('apf_dropbox_verifier', verifier);

                // Generate challenge using Web Crypto
                const encoder = new TextEncoder();
                const data = encoder.encode(verifier);
                const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
                const challenge = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

                let cleanPath = window.location.pathname.replace(/\/index\.html$/, '/');
                if (!cleanPath.endsWith('/')) cleanPath += '/';
                const redirectUri = window.location.origin + cleanPath;
                const scopes = 'files.content.write files.content.read sharing.write sharing.read';
                
                const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${dropboxAppKey}&response_type=code&token_access_type=offline&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&code_challenge=${challenge}&code_challenge_method=S256`;
                window.location.href = authUrl;
            };
        }
    }
}

function showTemporaryMessage(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '2rem';
    toast.style.right = '2rem';
    toast.style.padding = '0.75rem 1.5rem';
    toast.style.borderRadius = '0.5rem';
    toast.style.background = type === 'danger' ? 'var(--danger)' : 'var(--accent)';
    toast.style.color = 'white';
    toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.3)';
    toast.style.zIndex = '100000';
    toast.style.fontSize = '0.85rem';
    toast.style.fontWeight = '600';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '0.5rem';
    toast.style.transform = 'translateY(1rem)';
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    
    const icon = type === 'danger' ? 'ph-warning-circle' : 'ph-info';
    toast.innerHTML = `<i class="ph ${icon}"></i> ${msg}`;
    
    document.body.appendChild(toast);
    
    // Animation in
    setTimeout(() => {
        toast.style.transform = 'translateY(0)';
        toast.style.opacity = '1';
    }, 10);
    
    // Auto remove
    setTimeout(() => {
        toast.style.transform = 'translateY(1rem)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function populateLoginSectors() {
    if (!loginSector) return;
    
    const p = getCurrentProject() || state.projects.find(proj => proj.id === 'p_default');
    if (!p) return;

    // Root folders names from the tree
    const rootSectors = [...new Set(p.items.filter(i => i.parentId === null).map(i => i.name).sort())];
    
    const currentVal = loginSector.value;
    
    // Re-populate preserving "Selecione" and "APF"
    loginSector.innerHTML = '<option value="">Selecione seu setor...</option><option value="APF">APF (Administrativo)</option>';
    
    rootSectors.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        loginSector.appendChild(opt);
    });
    
    if (currentVal) loginSector.value = currentVal;
}


function applyAuthState() {
    if(!globalLogin || !managementContent) return;

    const tabsNav = document.querySelector('.tabs');
    const isMgmt = isMgmtActive();
    const apfSubmenu = document.getElementById('apf-submenu');
    const apfBtn = document.querySelector('.apf-access-btn');

    // Restore session if exists and not yet set
    if (!isAuthenticated) {
        const savedSector = sessionStorage.getItem('apf_session_sector');
        if (savedSector) {
            isAuthenticated = true;
            authenticatedSector = savedSector;
        }
    }

    if (!isAuthenticated) {
        // Site Completely Locked
        globalLogin.style.display = 'flex';
        document.querySelector('.main-layout').style.display = 'none';
        populateLoginSectors();
        if (inputPassword) inputPassword.focus();
        return;
    } else {
        globalLogin.style.display = 'none';
        document.querySelector('.main-layout').style.display = 'block';
    }

    // Update APF access button label
    if (apfBtn) {
        apfBtn.innerHTML = isMgmt ? '<i class="ph ph-sign-out"></i> SAIR' : 'APF';
        if (isMgmt) {
            apfBtn.style.borderColor = 'var(--danger)';
            apfBtn.style.color = 'var(--danger)';
        } else {
            apfBtn.style.borderColor = '';
            apfBtn.style.color = '';
        }
        
        // Hide APF button for non-APF sectors
        apfBtn.style.display = authenticatedSector === 'APF' ? 'inline-flex' : 'none';
    }

    if (isMgmt && authenticatedSector !== 'APF') {
        // Kick out non-admin from management
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));
        document.getElementById('tab-checklist').classList.add('active');
        document.querySelector('[data-tab="checklist"]').classList.add('active');
        showTemporaryMessage("Redirecionado: Você não possui permissão de APF.");
    }

    if (apfSubmenu) apfSubmenu.style.display = (isMgmt && authenticatedSector === 'APF') ? 'flex' : 'none';
    
    if (isMgmt) {
        managementContent.style.display = 'block';
        if (sidebarApf) sidebarApf.style.display = 'flex';
    } else {
        managementContent.style.display = 'none';
        if (sidebarApf) sidebarApf.style.display = 'flex';
    }

    // Update Logout and Banner
    if (btnLogout) btnLogout.style.display = 'inline-flex';
    if (authStatusBanner) {
        authStatusBanner.style.display = 'flex';
        authStatusBanner.innerHTML = `<i class="ph ph-user-circle"></i> Você está logado no acesso (${authenticatedSector})`;
    }
}

function logout() {
    if (confirm('Deseja realmente sair da sessão atual?')) {
        isAuthenticated = false;
        authenticatedSector = null;
        sessionStorage.removeItem('apf_session_sector');
        
        // Return to login screen
        if (globalLogin) globalLogin.style.display = 'flex';
        if (authStatusBanner) authStatusBanner.style.display = 'none';
        if (btnLogout) btnLogout.style.display = 'none';
        
        const mainLayout = document.querySelector('.main-layout');
        if (mainLayout) mainLayout.style.display = 'none';
        
        // Clear password input
        const inputPassword = document.getElementById('global-password-input');
        if (inputPassword) {
            inputPassword.value = '';
            inputPassword.focus();
        }
        
        applyAuthState();
        renderTree();
    }
}




// Project Management & Global UI
function updateGlobalDateUI() {
    const p = getCurrentProject();
    const dash = document.getElementById('project-dashboard');
    const nameEl = document.getElementById('checklist-proj-name');
    const subtitleEl = document.getElementById('checklist-subtitle');
    const noProjPlaceholder = document.getElementById('no-project-selected');
    const mainWrapper = document.getElementById('main-content-wrapper');
    const filterWrappers = document.querySelectorAll('.search-filters-group');
    const dueDateContainer = document.getElementById('due-date-container');

    // 1. Estado Inicial: Nenhum projeto selecionado
    if(!p || p.id === 'none') {
        if(noProjPlaceholder) noProjPlaceholder.style.display = 'flex';
        if(mainWrapper) mainWrapper.style.display = 'none';
        if(dash) dash.style.display = 'none';
        if(nameEl) nameEl.textContent = 'APF Checklist';
        if(subtitleEl) subtitleEl.textContent = 'Selecione um empreendimento no painel lateral';
        return;
    } 

    // Se houver projeto, mostrar o conteúdo principal
    if(noProjPlaceholder) noProjPlaceholder.style.display = 'none';
    if(mainWrapper) mainWrapper.style.display = 'block';

    // 2. Caso Especial: MODELO DE ENTREGA
    if(p.id === 'p_default') {
        if(dash) dash.style.display = 'none';
        if(nameEl) nameEl.textContent = 'MODELO DE ENTREGA';
        if(subtitleEl) subtitleEl.textContent = 'Estrutura padrão de pastas';
        if(currentProjectName) currentProjectName.textContent = 'MODELO DE ENTREGA';
        
        if (dueDateContainer) dueDateContainer.style.display = 'none';
        if (projectDueDateInp) { projectDueDateInp.disabled = true; projectDueDateInp.value = ''; }
        if (btnRenameProject) btnRenameProject.style.display = 'none';
        if (btnDeleteProject) btnDeleteProject.style.display = 'none';

        // Reseta filtro no modelo
        treeSearchFilter = 'all';
        return;
    }

    // 3. Caso Normal: Empreendimentos Reais
    if(nameEl) nameEl.textContent = p.name;
    if(subtitleEl) subtitleEl.textContent = 'Entrega de documentação';
    if(currentProjectName) currentProjectName.textContent = p.name;
    if(btnRenameProject) btnRenameProject.style.display = 'inline-flex';
    if(btnDeleteProject) btnDeleteProject.style.display = 'inline-flex';
    if(dueDateContainer) dueDateContainer.style.display = 'flex';
    if(projectDueDateInp) { projectDueDateInp.disabled = false; projectDueDateInp.value = p.dueDate || ''; }


    // Calcular Estatísticas para o Dashboard
    let allItems;
    if (p.pendenciaActive && !isMgmtActive()) {
        allItems = p.pendencias || [];
    } else {
        allItems = p.items.filter(i => {
            const hasChildren = p.items.some(child => child.parentId === i.id);
            return !hasChildren && i.parentId !== null;
        });
    }

    const applicableItems = allItems.filter(i => !i.isNotApplicable);
    const total = applicableItems.length;
    const validated = applicableItems.filter(i => (i.validationStatus === 'Validado' || i.validationStatus === 'APF check') && i.attachments?.length > 0).length;
    const withPoints = applicableItems.filter(i => i.validationStatus === 'Apontamento' && i.attachments?.length > 0).length;
    const pending = applicableItems.filter(i => !i.attachments || i.attachments.length === 0).length;
    const inAnalysis = total - validated - withPoints - pending;

    if(dash) {
        dash.style.display = 'grid';
        dash.innerHTML = `
            <div class="dashboard-card accent ${treeSearchFilter === 'validado' ? 'active' : ''}" onclick="handleDashboardFilter('validado', ${validated})">
                <span class="card-value">${validated}</span><span class="card-label">Validados</span>
            </div>
            <div class="dashboard-card warning ${treeSearchFilter === 'analise' ? 'active' : ''}" onclick="handleDashboardFilter('analise', ${inAnalysis})">
                <span class="card-value">${inAnalysis}</span><span class="card-label">Em Análise APF</span>
            </div>
            <div class="dashboard-card danger ${treeSearchFilter === 'pendente' ? 'active' : ''}" onclick="handleDashboardFilter('pendente', ${pending})">
                <span class="card-value">${pending}</span><span class="card-label">Pendentes</span>
            </div>
            <div class="dashboard-card danger ${treeSearchFilter === 'apontamento' ? 'active' : ''}" onclick="handleDashboardFilter('apontamento', ${withPoints})">
                <span class="card-value">${withPoints}</span><span class="card-label">Apontamentos</span>
            </div>
        `;
    }

    // Engenharia Aberta?
    const btnToggleEng = document.getElementById('btn-toggle-eng-analysis');
    if(p.engAnalysisOpened) {
        if (subtitleEl) {
            subtitleEl.innerHTML = '<i class="ph ph-file-search"></i> Engenharia Aberta';
            subtitleEl.className = 'badge-eng-subtitle';
        }
        if (btnToggleEng) {
            btnToggleEng.innerHTML = '<i class="ph ph-magnifying-glass"></i> Engenharia aberta';
            btnToggleEng.className = 'btn';
            btnToggleEng.style.backgroundColor = 'rgba(96, 165, 250, 0.1)';
            btnToggleEng.style.color = 'var(--info)';
            btnToggleEng.style.borderColor = 'var(--info)';
        }
        if (projectGlobalCountdown) projectGlobalCountdown.style.display = 'none';
    } else {
        if (subtitleEl) subtitleEl.className = 'default-subtitle';
    }
}

function updateManagementStatsUI() {
    const p = getCurrentProject();
    const dash = document.getElementById('management-dashboard');
    if(!p || p.id === 'p_default' || !dash) {
        if(dash) dash.style.display = 'none';
        return;
    }

    let allItems;
    if (p.pendenciaActive) {
        allItems = p.pendencias || [];
    } else {
        allItems = p.items.filter(i => {
            const hasChildren = p.items.some(child => child.parentId === i.id);
            return !hasChildren && i.parentId !== null;
        });
    }

    const applicableItems = allItems.filter(i => !i.isNotApplicable);
    
    const totalPending = applicableItems.filter(i => !i.attachments || i.attachments.length === 0).length;
    const awaitingValidation = applicableItems.filter(i => {
        const hasAtt = i.attachments && i.attachments.length > 0;
        const isValidated = i.validationStatus === 'APF check' || i.validationStatus === 'Validado';
        const isPointed = i.validationStatus === 'Apontamento';
        return hasAtt && !isValidated && !isPointed;
    }).length;

    dash.style.display = 'grid';
    dash.innerHTML = `
        <div class="dashboard-card danger ${treeSearchFilter === 'pendente' ? 'active' : ''}" onclick="handleDashboardFilter('pendente', ${totalPending})">
            <span class="card-value">${totalPending}</span>
            <span class="card-label">Documentos Pendentes</span>
        </div>
        <div class="dashboard-card warning ${treeSearchFilter === 'analise' ? 'active' : ''}" onclick="handleDashboardFilter('analise', ${awaitingValidation})">
            <span class="card-value">${awaitingValidation}</span>
            <span class="card-label">Em Análise APF</span>
        </div>
    `;
}

// Global filter handler for dashboard cards
window.handleDashboardFilter = function(filter, count) {
    if (count === 0 && filter !== 'all') {
        const labels = {
            'pendente': 'Pendentes',
            'apontamento': 'Apontamentos',
            'validado': 'Validados',
            'analise': 'em Análise APF'
        };
        showTemporaryMessage(`Sem documentos em ${labels[filter] || filter}`);
        return;
    }

    // Toggle filter: if clicking active, go back to 'all'
    if (treeSearchFilter === filter && filter !== 'all') {
        treeSearchFilter = 'all';
    } else {
        treeSearchFilter = filter;
    }
    
    updateGlobalDateUI();
    renderTree();
};



// function updateProjectDropdown() {
//     const mgmt = isMgmtActive();
//     projectSelect.innerHTML = '';
    
//     let visibleProjects = state.projects;
    
//     if (!mgmt) {
//         visibleProjects = state.projects.filter(p => p.id !== 'p_default');
        
//         const defOpt = document.createElement('option');
//         defOpt.value = 'none';
//         defOpt.textContent = visibleProjects.length === 0 ? '-- Crie um Empreendimento no Acesso APF --' : '-- Selecionar Empreendimento --';
//         projectSelect.appendChild(defOpt);
//     }
    
//     visibleProjects.forEach(p => {
//         const opt = document.createElement('option');
//         opt.value = p.id;
//         opt.textContent = p.name;
//         projectSelect.appendChild(opt);
//     });

//     if (mgmt) {
//         projectSelect.value = state.currentProjectId;
//     } else {
//         if (state.currentProjectId === 'p_default') {
//             projectSelect.value = 'none';
//         } else {
//             projectSelect.value = state.currentProjectId || 'none';
//         }
//     }

//     btnDeleteProject.style.display = state.projects.length > 1 ? 'inline-flex' : 'none';
    
//     const curr = getCurrentProject();
//     if(curr && curr.id !== 'none' && (mgmt || curr.id !== 'p_default')) {
//         currentProjectName.textContent = curr.name;
//     } else {
//         currentProjectName.textContent = '';
//     }
// }

// projectSelect.addEventListener('change', (e) => {
//     state.currentProjectId = e.target.value;
//     saveState();
//     updateGlobalDateUI();
//     renderTree();
//     renderTracking();
// });


function triggerPanelAnimation() {
    const mainCol = document.querySelector('.checklist-main-col');
    const analysisPanels = document.querySelector('.analysis-panels-wrapper');
    if (mainCol) {
        mainCol.classList.remove('animate-slide-in');
        void mainCol.offsetWidth;
        mainCol.classList.add('animate-slide-in');
    }
    if (analysisPanels) {
        analysisPanels.classList.remove('animate-slide-in');
        void analysisPanels.offsetWidth;
        analysisPanels.classList.add('animate-slide-in');
    }
}

// Tracker Render
function renderTracking() {
    if(!trackingContainer) return;
    trackingContainer.innerHTML = '';

    // ALWAYS filter out the template from the sidebar as per user request
    const trackableProjects = state.projects.filter(p => p.id !== 'p_default');
    
    trackableProjects.sort((a, b) => {
        // 1. Resolução de Pendências ATIVA (Topo da lista)
        // Priorizar o que está há MAIS tempo (data mais antiga)
        if (a.pendenciaActive && b.pendenciaActive) {
            const dateA = a.pendenciaStartDate ? new Date(a.pendenciaStartDate) : new Date('9999-12-31');
            const dateB = b.pendenciaStartDate ? new Date(b.pendenciaStartDate) : new Date('9999-12-31');
            if (dateA < dateB) return -1;
            if (dateA > dateB) return 1;
        }
        if (a.pendenciaActive && !b.pendenciaActive) return -1;
        if (!a.pendenciaActive && b.pendenciaActive) return 1;

        // 2. Engenharia Aberta sempre no final da fila
        if (a.engAnalysisOpened && !b.engAnalysisOpened) return 1;
        if (!a.engAnalysisOpened && b.engAnalysisOpened) return -1;

        // 3. Prioridade por Data (Mais vencidos ou mais próximos primeiro)
        const hasDateA = !!a.dueDate;
        const hasDateB = !!b.dueDate;
        
        if (hasDateA && !hasDateB) return -1;
        if (!hasDateA && hasDateB) return 1;
        
        if (hasDateA && hasDateB) {
            const daysA = calculateDays(a.dueDate);
            const daysB = calculateDays(b.dueDate);
            if (daysA !== daysB) return daysA - daysB;
        }

        return 0;
    });
    
    if(trackableProjects.length === 0) {
        trackingContainer.innerHTML = '<p style="color:var(--text-muted); padding: 1rem; border: 1px dashed rgba(255,255,255,0.1); border-radius:0.5rem;"><i class="ph ph-warning"></i> Nenhum empreendimento ativo criado ainda. Primeiramente, crie no Acesso APF.</p>';
        return;
    }

    trackableProjects.forEach((p, i) => {
        const card = document.createElement('div');
        const isActive = p.id === localUI.currentProjectId ? 'active' : '';
        const isEng = p.engAnalysisOpened ? 'eng-active' : '';
        const isPendencia = p.pendenciaActive ? 'pendencia-active' : '';
        card.className = `tracking-card glass-panel ${isActive} ${isEng} ${isPendencia}`;
        
        // Define color for the status indicator pseudo-element
        let statusColor = 'var(--primary)';
        if(p.pendenciaActive) statusColor = 'var(--danger)';
        else if(p.engAnalysisOpened) statusColor = 'var(--info)';
        card.style.setProperty('--indicator-color', statusColor);
        
        card.addEventListener('click', () => {
            if(localUI.currentProjectId === p.id) return;
            localUI.currentProjectId = p.id;
            localUI.expandedIds.clear(); // Garantir que as pastas fiquem ocultas por padrão ao trocar de projeto
            saveLocalUI();
            updateGlobalDateUI();
            renderTree();
            renderTracking();
            triggerPanelAnimation();
        });

        let prazoText = 'Sem data inicializada';
        let dClass = 'good';
        let progressPct = 0;
        let dateDesc = 'Cadastre no APF';
        let fillClass = 'good';

        if(p.dueDate) {
            const diff = calculateDays(p.dueDate);
            if(diff === 0) { prazoText = 'Entrega Hoje!'; dClass='good'; }
            else if(diff > 0) { prazoText = `Faltam ${diff} dia(s)`; dClass='good'; }
            else { prazoText = `Atrasado ${Math.abs(diff)} dia(s)`; dClass='late'; }

            dateDesc = formatDateToPT(p.dueDate);
            const bizDays = calculateBusinessDays(p.dueDate);
            const bizDaysHtml = (diff > 0) ? `<div style="font-size: 0.75rem; opacity: 0.7; margin-top: 2px;">${bizDays} dias úteis</div>` : '';
            prazoText += bizDaysHtml;

            if (p.createdAt) {
                const tStart = new Date(p.createdAt).getTime();
                const tEnd = new Date(p.dueDate).getTime();
                const tNow = new Date().getTime();
                
                if (tEnd > tStart) {
                    progressPct = ((tNow - tStart) / (tEnd - tStart)) * 100;
                    if(progressPct > 100) progressPct = 100;
                    if(progressPct < 0) progressPct = 0;
                } else if(tNow >= tEnd) {
                    progressPct = 100;
                }
            }
            if(diff < 0) { fillClass = 'late'; }
            else if(diff >= 0 && diff <= 5 && progressPct > 70) { fillClass = 'warning'; }
        }
        
        const fillColors = {
            'good': 'var(--primary)',
            'late': 'var(--danger)',
            'warning': 'var(--warning)'
        };
        const barColor = fillColors[fillClass] || 'var(--primary)';
        const textCol = dClass === 'late' ? 'var(--danger)' : 'var(--accent)';
        const engStatusIcon = p.engAnalysisOpened ? '<i class="ph ph-file-search text-accent" title="Engenharia Aberta"></i> ' : '';

        let statusText = prazoText;
        let dateText = p.dueDate ? formatDateToPT(p.dueDate) : '--/--/----';
        let statusCol = textCol;

        let trackingLine = '';
        if (p.pendenciaActive) {
            const start = p.pendenciaStartDate ? new Date(p.pendenciaStartDate) : new Date();
            start.setHours(0,0,0,0);
            const today = new Date();
            today.setHours(0,0,0,0);
            const diffDays = Math.floor((today - start) / (1000 * 60 * 60 * 24));
            const displayDays = diffDays >= 0 ? diffDays : 0;
            
            trackingLine = `<span style="color: var(--danger); font-weight: 700; display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-warning-diamond"></i> Resolução de pendências │ ${displayDays} dias</span>`;
        } else if (p.engAnalysisOpened) {
            trackingLine = `<span style="color: #1e3a8a; font-weight: 700; display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-file-search"></i> Engenharia Aberta</span>`;
        } else if (!p.dueDate) {
            trackingLine = `<span style="color: var(--text-muted); font-weight: 500;">Sem prazo</span>`;
        } else {
            const barePrazo = statusText.replace(/<div.*/, '');
            const bizHtml = statusText.includes('<div') ? statusText.match(/<div.*/)[0] : '';

            trackingLine = `
                <div style="display: flex; align-items: flex-start; width: 100%;">
                    <span style="color: var(--text-muted); font-weight: 500; white-space: nowrap;">${dateText}</span>
                    <span style="color: rgba(255,255,255,0.2); margin: 0 0.5rem;">┃</span>
                    <div style="display: flex; flex-direction: column; color: ${statusCol};">
                        <span style="font-weight: 700;">${barePrazo}</span>
                        ${bizHtml}
                    </div>
                </div>
            `;
        }

        // Define colors for the Title and Icon
        let titleStyle = '';
        let iconStyle = 'color: var(--primary);';
        if (p.pendenciaActive) {
            titleStyle = 'color: var(--danger);';
            iconStyle = 'color: var(--danger);';
        } else if (p.engAnalysisOpened) {
            titleStyle = 'color: #1e3a8a;'; // Azul marinho/escuro
            iconStyle = 'color: #1e3a8a;';
        }

        // Contagem de apontamentos de APF
        const projApontamentos = p.items.filter(i => i.validationStatus === 'Apontamento').length;

        card.innerHTML = `
            <div class="tracking-body">
                <div class="mb-1 flex-between" style="align-items: center; gap: 0.5rem;">
                    <h3 style="font-weight:700; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; margin: 0; ${titleStyle}" title="${p.name}"><i class="ph ph-buildings" style="${iconStyle}"></i> ${p.name}</h3>
                    <div style="display: flex; gap: 0.35rem;">
                        ${p.pendencias?.length > 0 ? `
                            <div style="background:rgba(239, 68, 68, 0.15); color:var(--danger); font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 0.35rem; font-weight: 700; display: flex; align-items: center; gap: 0.2rem;" title="Pendências ativas">
                                <i class="ph ph-warning-circle"></i> ${p.pendencias.length}
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="mb-1" style="font-size: 0.75rem; width: 100%; margin-top: 0.25rem;">
                    ${trackingLine}
                </div>
            </div>
        `;
        trackingContainer.appendChild(card);
    });

    renderAnalysisPanels();
}

// Rendering Tree Helpers
function getChildItems(parentId) {
    return getItems()
        .filter(item => item.parentId === parentId)
        .sort((a, b) => {
            // Root folders keep their original order; subfolders sorted alphabetically
            if (a.parentId !== null) return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
            return 0;
        });
}

function getNodeStats(itemId) {
    const p = getCurrentProject();
    if (!p) return { pendente: 0, apontamento: 0 };

    // If it's a root folder (sector), and we have pre-calculated stats for the project
    // we could potentially optimize further, but for now we still do the sub-tree sweep
    // unless we store stats per folder. For now, let's keep the sweep but use it smarter.
    
    let pendente = 0;
    let apontamento = 0;
    
    const children = getChildItems(itemId);
    const item = p.items.find(i => i.id === itemId);
    
    if(item && item.parentId !== null && children.length === 0) {
        if(!item.isNotApplicable && (!item.attachments || item.attachments.length === 0)) {
            pendente++;
        }
        if(item.validationStatus === 'Apontamento') {
            apontamento++;
        }
    }
    
    children.forEach(child => {
        const childStats = getNodeStats(child.id);
        pendente += childStats.pendente;
        apontamento += childStats.apontamento;
    });
    
    return { pendente, apontamento };
}

async function compressImage(file) {
    // Only compress images
    if (!file.type.startsWith('image/')) return file;

    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Max resolution 1920px (Full HD)
                const MAX_SIZE = 1920;
                if (width > height) {
                    if (width > MAX_SIZE) {
                        height *= MAX_SIZE / width;
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width *= MAX_SIZE / height;
                        height = MAX_SIZE;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    const compressedFile = new File([blob], file.name, {
                        type: 'image/jpeg',
                        lastModified: Date.now(),
                    });
                    resolve(compressedFile);
                }, 'image/jpeg', 0.7); // 70% quality as requested
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function renderPendenciasChecklist(curr) {
    if (!curr || !curr.pendenciaActive || !curr.pendencias || curr.pendencias.length === 0) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'pendencias-checklist-area';
    wrapper.style.marginBottom = '2rem';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '1rem';
    
    // Header for Pendências
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '0.5rem';
    header.style.marginBottom = '1rem';
    header.style.color = 'var(--danger)';
    header.innerHTML = '<i class="ph ph-warning-diamond" style="font-size: 1.5rem;"></i> <strong style="font-size: 1.1rem; text-transform: uppercase; letter-spacing: 0.05em;">PENDÊNCIAS CAIXA</strong>';
    wrapper.appendChild(header);

    curr.pendencias.forEach(p => {
        const node = document.createElement('div');
        node.className = 'tree-item pendencia-item';
        
        const itemLeft = document.createElement('div');
        itemLeft.className = 'item-left';
        itemLeft.innerHTML = `
            <i class="ph ph-file-warning item-icon"></i>
            <div style="display: flex; flex-direction: column;">
                <span class="item-name" style="font-weight: 700; color: var(--text-main);">${p.docName}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted);">${p.sector}</span>
                ${p.specification ? `<div style="margin-top: 0.25rem; font-size: 0.75rem; color: var(--primary); display: flex; align-items: flex-start; gap: 0.3rem; flex-wrap: wrap; line-height: 1.4;"><i class="ph ph-chat-centered-dots" style="margin-top: 0.15rem;"></i> <strong style="flex-shrink: 0;">Especificação:</strong> <span style="flex: 1; min-width: 200px; white-space: normal; word-break: break-word;">${p.specification}</span></div>` : ''}
            </div>
        `;

        const itemRight = document.createElement('div');
        itemRight.className = 'item-right';

        const hasAtt = p.attachments && p.attachments.length > 0;
        
        // Status Badge
        const statusBadge = document.createElement('span');
        statusBadge.className = hasAtt ? 'badge badge-entregue badge-sm' : 'badge badge-pendente badge-sm';
        statusBadge.textContent = hasAtt ? 'Entregue' : 'Pendente';
        
        const statusRow = document.createElement('div');
        statusRow.className = 'item-status-row';
        statusRow.style.display = 'flex';
        statusRow.style.gap = '0.3rem';
        statusRow.style.alignItems = 'center';
        statusRow.appendChild(statusBadge);

        // Validation badge for pendencies
        if(hasAtt && p.validationStatus) {
            const valBadge = document.createElement('span');
            if(p.validationStatus === 'APF check' || p.validationStatus === 'Validado') {
                valBadge.className = 'badge badge-validado badge-sm';
                valBadge.textContent = 'Validado';
            }
            else if(p.validationStatus === 'Apontamento') valBadge.className = 'badge badge-apontamento badge-sm';
            else valBadge.className = 'badge badge-analise badge-sm';
            if(p.validationStatus !== 'APF check' && p.validationStatus !== 'Validado') valBadge.textContent = p.validationStatus;
            statusRow.appendChild(valBadge);
        }

        // Attach Button
        const btnAttach = document.createElement('button');
        btnAttach.className = 'icon-btn attach-icon-btn';
        btnAttach.title = 'Anexar documento de pendência';
        btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
        
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.className = 'hidden';
        fileInput.multiple = true;
        fileInput.onchange = (e) => window.handleFileUpload(p.id, e.target.files, true);
        btnAttach.onclick = () => fileInput.click();
        
        statusRow.appendChild(btnAttach);
        itemRight.appendChild(statusRow);

        if (hasAtt) {
            const attRow = document.createElement('div');
            attRow.className = 'inline-attachments-row';
            p.attachments.forEach(att => {
                const badge = document.createElement('div');
                badge.className = 'inline-attachment';
                badge.innerHTML = `
                    <span class="text-truncate" style="max-width: 150px;" title="${att.name}">${att.name}</span>
                    <button class="icon-btn preview" title="Visualizar"><i class="ph ph-eye"></i></button>
                    <button class="icon-btn delete" title="Remover"><i class="ph ph-x"></i></button>
                `;
                badge.querySelector('.preview').onclick = () => window.openPreview(att);
                badge.querySelector('.delete').onclick = () => window.handleDeleteFile(p.id, att.id, true);
                attRow.appendChild(badge);
            });
            itemRight.appendChild(attRow);
        }

        // Observation Field (Compact and toggleable)
        const btnObs = document.createElement('button');
        btnObs.className = 'btn btn-outline btn-sm';
        btnObs.style.padding = '0.2rem 0.5rem';
        btnObs.style.fontSize = '0.7rem';
        btnObs.innerHTML = '<i class="ph ph-note"></i> Obs.';

        const obsBox = document.createElement('div');
        obsBox.className = 'justification-box';
        obsBox.style.marginTop = '0.4rem';
        
        const obsInput = document.createElement('textarea');
        obsInput.className = 'input-modern';
        obsInput.style.width = '100%';
        obsInput.style.height = '60px';
        obsInput.style.fontSize = '0.75rem';
        obsInput.placeholder = 'Observação...';
        obsInput.value = p.observation || '';
        obsInput.onchange = (e) => { 
            const oldVal = p.observation || '';
            p.observation = e.target.value; 
            saveState(); 
            if (oldVal !== p.observation) {
                addAuditLog('Observação Adicionada', `Nova observação em <strong>${p.docName}</strong>: "${p.observation}"`, 'info');
            }
        };
        
        obsBox.appendChild(obsInput);
        if(p.observation && p.observation.trim() !== '') {
            btnObs.style.borderColor = 'var(--accent)';
            btnObs.style.color = 'var(--accent)';
        }
        btnObs.onclick = () => obsBox.classList.toggle('open');

        itemRight.appendChild(btnObs);
        
        itemRight.appendChild(obsBox);

        node.appendChild(itemLeft);
        node.appendChild(itemRight);
        wrapper.appendChild(node);
    });

    checklistContainer.appendChild(wrapper);
}

function updateProjectProgressUI(curr) {
    const container = document.getElementById('project-progress-container');
    if (!container) return;
    if (!curr || curr.id === 'p_default') {
        container.style.display = 'none';
        return;
    }
    
    let progressPct = 0;
    let label = "Progresso de entrega";
    let sublabel = "Documentação indexada no Checklist";

    if (curr.pendenciaActive) {
        label = "Progresso de resolução de pendências";
        sublabel = "Documentação enviada para o painel de Pendências CAIXA";
        const pendencias = curr.pendencias || [];
        if (pendencias.length > 0) {
            const resolvedCount = pendencias.filter(p => p.attachments && p.attachments.length > 0).length;
            progressPct = Math.round((resolvedCount / pendencias.length) * 100);
        }
    } else {
        // Count items that are subfolders/items, ignoring top-level folders.
        const leafItems = curr.items.filter(i => i.parentId !== null);
        if (leafItems.length > 0) {
            // Documentos com status "Apontamento" não contam para o progresso de entrega, mesmo com anexos.
            const deliveredCount = leafItems.filter(i => i.attachments && i.attachments.length > 0 && i.validationStatus !== 'Apontamento').length;
            progressPct = Math.round((deliveredCount / leafItems.length) * 100);
        }
    }
    
    container.style.display = 'block';
    container.innerHTML = `
        <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; background: rgba(0,0,0,0.15); padding: 0.75rem 1rem; border-radius: 0.75rem;">
            <div class="circular-progress-container">
                <div class="circular-progress" style="--progress: ${progressPct}%;"></div>
                <span class="progress-text">${progressPct}%</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.2rem;">
                <span style="font-size: 0.95rem; font-weight: 600; color: var(--text-main);">${label}</span>
                <span style="font-size: 0.8rem; color: var(--text-muted);">${sublabel}</span>
            </div>
        </div>
    `;
}

function calculateDays(dueDate) {
    if(!dueDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // targetDate format: YYYY-MM-DD
    const parts = dueDate.split('-');
    const target = new Date(parts[0], parts[1] - 1, parts[2]);
    target.setHours(0, 0, 0, 0);
    
    const diffTime = target - today;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function calculateBusinessDays(targetDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(targetDateStr);
    target.setHours(0, 0, 0, 0);
    
    if (target < today) return 0;
    
    let count = 0;
    let current = new Date(today);
    
    while (current < target) {
        current.setDate(current.getDate() + 1);
        const day = current.getDay();
        if (day !== 0 && day !== 6) { // 0 = Sunday, 6 = Saturday
            count++;
        }
    }
    return count;
}

function expandRelevantNodes() {
    const items = getItems();
    if (!items || items.length === 0) return;

    items.forEach(item => {
        const hasChildren = items.some(child => child.parentId === item.id);
        if (!hasChildren) return; // Só interessa expandir quem tem filhos

        const anyChildMatches = (nodeId) => {
            const nodeChildren = items.filter(i => i.parentId === nodeId);
            return nodeChildren.some(c => {
                const cMatches = c.name.toLowerCase().includes(treeSearchQuery);
                const cHasAtt = c.attachments && c.attachments.length > 0;
                const cValid = c.validationStatus === 'APF check' || c.validationStatus === 'Validado';
                const cPointed = c.validationStatus === 'Apontamento';

                let cMatchesFilter = true;
                if (treeSearchFilter === 'pendente') cMatchesFilter = !cHasAtt;
                else if (treeSearchFilter === 'apontamento') cMatchesFilter = cHasAtt && cPointed;
                else if (treeSearchFilter === 'validado') cMatchesFilter = cHasAtt && cValid;
                else if (treeSearchFilter === 'analise') cMatchesFilter = cHasAtt && !cValid && !cPointed;
                
                return (cMatches && cMatchesFilter) || anyChildMatches(c.id);
            });
        };

        if (anyChildMatches(item.id)) {
            localUI.expandedIds.add(item.id);
        }
    });
    saveLocalUI();
}

function formatDateToPT(isoStr) {
    if(!isoStr) return '';
    const parts = isoStr.split('-');
    if(parts.length !== 3) return isoStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function renderTree() {
    const p = getCurrentProject();
    if (!p) return;

    // Update Toggle All Button Text
    const btnChecklist = document.getElementById('btn-toggle-all-checklist');
    const btnMgmt = document.getElementById('btn-toggle-all-mgmt');
    
    // Check if at least one folder is expanded
    const foldersWithChildren = p.items.filter(item => p.items.some(child => child.parentId === item.id));
    const anyExpanded = foldersWithChildren.some(f => localUI.expandedIds.has(f.id));

    const updateBtn = (btn) => {
        if (!btn) return;
        const label = btn.querySelector('.label');
        if (anyExpanded) {
            label.textContent = 'Ocultar tudo';
        } else {
            label.textContent = 'Mostrar tudo';
        }
    };
    updateBtn(btnChecklist);
    updateBtn(btnMgmt);

    if(!checklistContainer || !managementContainer) return;
    
    // Clear
    checklistContainer.innerHTML = '';
    managementContainer.innerHTML = '';
    
    const currProj = getCurrentProject();
    const mgmt = isMgmtActive();
    
    if (!currProj) return;

    // Sync panel references
    const pMgmtPanel = document.getElementById('pendencias-mgmt-panel');
    const pToggleBtn = document.getElementById('btn-toggle-pendencias');

    if (!mgmt && (currProj.id === 'none' || currProj.id === 'p_default')) {
        let msg = '<i class="ph ph-warning"></i> Selecione um Empreendimento acima para visualizar a documentação.';
        if(state.projects.length <= 1) msg = '<i class="ph ph-warning"></i> Você precisa criar um Empreendimento novo na aba "Acesso APF" para manipular os checklists.';
        checklistContainer.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding: 3rem 1rem; border: 1px dashed var(--panel-border); border-radius: 0.5rem;">${msg}</div>`;
        return;
    }

    // Sync panel visibility with proj state
    if (pMgmtPanel && pToggleBtn) {
        const shouldShow = mgmt && currProj.id !== 'p_default' && currProj.pendenciaActive;
        if (shouldShow) {
            pMgmtPanel.classList.remove('hidden');
            pToggleBtn.classList.add('btn-danger');
            pToggleBtn.classList.remove('btn-outline');
            pToggleBtn.innerHTML = '<i class="ph ph-warning-diamond"></i> Pendências Ativas';
            renderPendenciasMgmt();
        } else {
            pMgmtPanel.classList.add('hidden');
            pToggleBtn.classList.add('btn-outline');
            pToggleBtn.classList.remove('btn-danger');
            pToggleBtn.innerHTML = '<i class="ph ph-warning-diamond"></i> Resolução de pendências';
        }
    }

    // Render Pendências Checklist if active
    if (!mgmt) renderPendenciasChecklist(currProj);

    const rootItems = getChildItems(null);
    const isSearching = treeSearchQuery.length > 0 || treeSearchFilter !== 'all';

    // Logic to hide sectors when Pendências is active (Local UI)
    let showItems = true;
    if (currProj.pendenciaActive && !mgmt) {
        if (!localUI.showFullChecklistDuringPendencia) showItems = false;
        
        const toggleDiv = document.createElement('div');
        toggleDiv.style.margin = '1.5rem 0 1rem';
        toggleDiv.style.textAlign = 'center';
        
        const btnToggleFull = document.createElement('button');
        btnToggleFull.className = 'btn btn-outline btn-sm';
        btnToggleFull.innerHTML = localUI.showFullChecklistDuringPendencia 
            ? '<i class="ph ph-eye-slash"></i> Ocultar Documentação dos Setores' 
            : '<i class="ph ph-eye"></i> Exibir Documentação dos Setores';
        
        btnToggleFull.onclick = () => {
            localUI.showFullChecklistDuringPendencia = !localUI.showFullChecklistDuringPendencia;
            saveLocalUI();
            renderTree();
        };
        
        toggleDiv.appendChild(btnToggleFull);
        checklistContainer.appendChild(toggleDiv);
    }

    rootItems.forEach((item) => {
        const node = createNode(item, 0); // Level 0
        if (node) {
            if (mgmt) managementContainer.appendChild(node);
            else if (showItems) checklistContainer.appendChild(node);
        }
    });

    if (isSearching) {
        const activeContainer = mgmt ? managementContainer : checklistContainer;
        if (activeContainer.children.length === 0 || (activeContainer.children.length === 1 && activeContainer.querySelector('button'))) {
            activeContainer.innerHTML += `<div style="text-align:center; padding:3rem; color:var(--text-muted);">
                <i class="ph ph-magnifying-glass" style="font-size:2rem; opacity:0.3;"></i>
                <p style="margin-top:1rem;">Nenhum documento encontrado para "${treeSearchQuery}"</p>
            </div>`;
        }
    }

    if (!mgmt) updateProjectProgressUI(currProj);
    else updateManagementStatsUI();
    renderAnalysisPanels();
}

function createNode(item, level) {
    const children = getChildItems(item.id);
    const isRootFolder = item.parentId === null;
    const isMgmt = isMgmtActive();
    const currProj = getCurrentProject();
    
    // Per-sector permission logic
    const nodeSector = getItemSector(item.id);
    const canEdit = authenticatedSector === 'APF' || authenticatedSector === nodeSector;

    // SEARCH & FILTER LOGIC
    if (treeSearchQuery || treeSearchFilter !== 'all') {
        const matchesQuery = item.name.toLowerCase().includes(treeSearchQuery);
        const hasAtt = item.attachments && item.attachments.length > 0;
        
        let matchesFilter = true;
        if (treeSearchFilter === 'pendente') matchesFilter = !hasAtt;
        else if (treeSearchFilter === 'apontamento') matchesFilter = hasAtt && item.validationStatus === 'Apontamento';

        // An item should be shown if it matches OR if any of its children match
        const anyChildMatches = (nodeId) => {
            const nodeChildren = getItems().filter(i => i.parentId === nodeId);
            return nodeChildren.some(c => {
                const cMatches = c.name.toLowerCase().includes(treeSearchQuery);
                const cHasAtt = c.attachments && c.attachments.length > 0;
                let cMatchesFilter = true;
                if (treeSearchFilter === 'pendente') cMatchesFilter = !cHasAtt;
                else if (treeSearchFilter === 'apontamento') cMatchesFilter = cHasAtt && c.validationStatus === 'Apontamento';
                
                return (cMatches && cMatchesFilter) || anyChildMatches(c.id);
            });
        };

        if (!(matchesQuery && matchesFilter) && !anyChildMatches(item.id)) {
            return null; // Skip this node
        }
    }

    const nodeWrapper = document.createElement('div');
    const isExpanded = localUI.expandedIds.has(item.id);
    nodeWrapper.className = `tree-node ${isExpanded ? '' : 'collapsed'}`;

    const nodeChildren = getChildItems(item.id);
    const hasChildren = nodeChildren.length > 0;

    // The Item div
    const itemDiv = document.createElement('div');
    itemDiv.className = 'tree-item';

    const itemLeft = document.createElement('div');
    itemLeft.className = 'item-left';

    const chevron = document.createElement('i');
    chevron.className = `ph ph-caret-down ${hasChildren ? '' : 'ph-caret-right'}`; 
    chevron.style.opacity = hasChildren ? '1' : '0';

    const icon = document.createElement('i');
    if(isRootFolder) {
        let iconClass = 'ph-folder-notch-open';
        const n = item.name.toLowerCase();
        if(n.includes('legaliza')) iconClass = 'ph-scales';
        else if(n.includes('arquit') || n.includes('urbani')) iconClass = 'ph-compass-tool';
        else if(n.includes('engenh')) iconClass = 'ph-wrench';
        else if(n.includes('sustent')) iconClass = 'ph-leaf';
        icon.className = `ph ${iconClass} item-icon`;
    }
    else icon.className = (item.attachments && item.attachments.length > 0) ? 'ph ph-file-text item-icon' : 'ph ph-folder item-icon';
    if(item.protected && isMgmt && !isRootFolder) icon.className = 'ph ph-folder-lock item-icon';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name text-truncate';
    if(isRootFolder) nameSpan.classList.add('root-name'); 
    nameSpan.style.maxWidth = '300px';
    nameSpan.title = 'Clique para Expandir ou Ocultar';
    nameSpan.appendChild(chevron);
    nameSpan.appendChild(icon);
    
    nameSpan.onclick = () => {
        if(hasChildren) {
            if (localUI.expandedIds.has(item.id)) {
                localUI.expandedIds.delete(item.id);
            } else {
                localUI.expandedIds.add(item.id);
            }
            saveLocalUI();
            renderTree();
        }
    };

    const titleText = document.createTextNode(' ' + item.name);
    nameSpan.appendChild(titleText);

    // INDICATORS for ROOT FOLDERS
    if(isRootFolder && localUI.currentProjectId !== 'p_default') {
        const stats = getNodeStats(item.id);
        const totalAlerts = stats.pendente + stats.apontamento;
        const indicatorsCont = document.createElement('div');
        indicatorsCont.className = 'sector-indicators';

        if (totalAlerts > 0) {
            const circle = document.createElement('span');
            circle.className = 'pending-circle';
            circle.textContent = totalAlerts;
            circle.title = `${totalAlerts} item(s) com pendências ou apontamentos`;
            indicatorsCont.appendChild(circle);
            itemLeft.prepend(indicatorsCont);
        } else {
            const spacer = document.createElement('div');
            spacer.style.width = '60px'; 
            spacer.style.flexShrink = '0';
            spacer.style.marginRight = '0.75rem';
            itemLeft.prepend(spacer);
        }
    }

    itemLeft.appendChild(nameSpan);
    
    const itemRight = document.createElement('div');
    itemRight.className = 'item-right';

    if(!isMgmt) {
        if(!isRootFolder && !hasChildren) {
            const hasAtt = item.attachments && item.attachments.length > 0;
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.className = 'file-input-hidden';
            fileInput.multiple = true;
            fileInput.onchange = (e) => window.handleFileUpload(item.id, e.target.files);
            itemRight.appendChild(fileInput);

            const statusRow = document.createElement('div');
            statusRow.className = 'item-status-row';

            const badgesWrap = document.createElement('div');
            badgesWrap.style.display = 'flex';
            badgesWrap.style.gap = '0.3rem';
            badgesWrap.style.flexWrap = 'wrap';
            badgesWrap.style.alignItems = 'center';

            const statusBadge = document.createElement('span');
            if (item.isNotApplicable) {
                statusBadge.className = 'badge badge-na badge-sm';
                statusBadge.textContent = 'Não Necessário';
            } else {
                statusBadge.className = hasAtt ? 'badge badge-entregue badge-sm' : 'badge badge-pendente badge-sm';
                statusBadge.textContent = hasAtt ? 'Entregue' : 'Pendente';
            }
            badgesWrap.appendChild(statusBadge);

            if(hasAtt && item.validationStatus) {
                const valBadge = document.createElement('span');
                if(item.validationStatus === 'APF check' || item.validationStatus === 'Validado') {
                    valBadge.className = 'badge badge-validado badge-sm';
                    valBadge.textContent = 'Validado';
                }
                else if(item.validationStatus === 'Apontamento') {
                    valBadge.className = 'badge badge-apontamento badge-sm';
                    valBadge.textContent = 'Apontamento';
                }
                else {
                    valBadge.className = 'badge badge-analise badge-sm';
                    valBadge.textContent = item.validationStatus || 'Em Análise';
                }
                badgesWrap.appendChild(valBadge);
            }

            statusRow.appendChild(badgesWrap);

            const btnAttach = document.createElement('button');
            btnAttach.className = 'icon-btn attach-icon-btn';
            btnAttach.title = 'Anexar documento';
            btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
            btnAttach.onclick = () => fileInput.click();
            
            if (item.isNotApplicable) {
                btnAttach.disabled = true;
                btnAttach.style.opacity = '0.5';
                btnAttach.title = 'Documento dispensado';
                fileInput.disabled = true;
            }

            if (!canEdit) {
                btnAttach.disabled = true;
                btnAttach.style.opacity = '0.3';
                btnAttach.title = 'Apenas o setor proprietário pode anexar';
                fileInput.disabled = true;
            }

            if (hasAtt) {
                statusRow.appendChild(btnAttach);
            }
            itemRight.appendChild(statusRow);
            
            if(hasAtt) {
                const inlineAttachments = document.createElement('div');
                inlineAttachments.className = 'inline-attachments-row';
                item.attachments.forEach(att => {
                    const attBadge = document.createElement('div');
                    attBadge.className = 'inline-attachment';
                    const nameTxt = document.createElement('span');
                    nameTxt.className = 'text-truncate';
                    nameTxt.style.maxWidth = '150px';
                    nameTxt.title = att.name;
                    nameTxt.textContent = att.name;

                    const btnView = document.createElement('button');
                    btnView.className = 'icon-btn';
                    btnView.innerHTML = '<i class="ph ph-eye"></i>';
                    btnView.onclick = () => window.openPreview(att);
                    
                    const btnDel = document.createElement('button');
                    btnDel.className = 'icon-btn delete';
                    btnDel.innerHTML = '<i class="ph ph-x"></i>';
                    btnDel.onclick = () => window.handleDeleteFile(item.id, att.id);
                    if (!canEdit) {
                        btnDel.disabled = true;
                        btnDel.style.opacity = '0.3';
                        btnDel.style.cursor = 'not-allowed';
                    }

                    attBadge.appendChild(nameTxt);
                    if (att.aiCheckResult) {
                        const aiStatusIcon = document.createElement('i');
                        const isSuccess = att.aiCheckResult.toLowerCase().includes('sim') && !att.aiCheckResult.toLowerCase().includes('não');
                        aiStatusIcon.className = isSuccess ? 'ph ph-shield-check text-accent' : 'ph ph-shield-warning text-warning';
                        aiStatusIcon.title = `[IA Check autom.]: ${att.aiCheckResult}`;
                        attBadge.appendChild(aiStatusIcon);
                    }
                    attBadge.appendChild(btnView);
                    attBadge.appendChild(btnDel);
                    inlineAttachments.appendChild(attBadge);
                });
                itemRight.appendChild(inlineAttachments);
            } else if (!item.isNotApplicable) {
                const pendingBar = document.createElement('div');
                pendingBar.className = 'pending-action-bar';
                const forecastGroup = document.createElement('div');
                forecastGroup.style.display = 'flex';
                forecastGroup.style.alignItems = 'center';
                forecastGroup.style.gap = '0.3rem';

                const forecastInput = document.createElement('input');
                forecastInput.type = 'date';
                forecastInput.className = 'input-modern';
                forecastInput.style.maxWidth = '115px';
                forecastInput.style.padding = '0.2rem 0.4rem';
                forecastInput.style.fontSize = '0.75rem';
                if(item.forecastDate) forecastInput.value = item.forecastDate;
                forecastInput.onchange = (e) => { item.forecastDate = e.target.value; saveState(); };
                if (!canEdit) forecastInput.disabled = true;

                forecastGroup.innerHTML = '<label style="font-size:0.75rem; color:var(--text-muted);">Prev:</label>';
                forecastGroup.appendChild(forecastInput);

                const btnJustify = document.createElement('button');
                btnJustify.className = 'btn btn-outline btn-sm';
                btnJustify.innerHTML = '<i class="ph ph-chat-text"></i> Justif.';
                if (!canEdit) {
                    btnJustify.disabled = true;
                    btnJustify.style.opacity = '0.5';
                }
                
                const justBox = document.createElement('div');
                justBox.className = 'justification-box';
                const justInput = document.createElement('textarea');
                justInput.className = 'input-modern';
                justInput.style.width = '100%';
                justInput.style.height = '60px';
                justInput.placeholder = 'Justificativa...';
                if(item.justification) justInput.value = item.justification;
                justInput.onchange = (e) => { 
                    const oldVal = item.justification || '';
                    item.justification = e.target.value; 
                    saveState(); 
                    if (oldVal !== item.justification) {
                        addAuditLog('Justificativa Adicionada', `Nova justificativa em <strong>${item.name}</strong>: "${item.justification}"`, 'info');
                    }
                };
                if (!canEdit) justInput.disabled = true;
                justBox.appendChild(justInput);

                if(item.justification && item.justification.trim() !== '') {
                    btnJustify.style.borderColor = 'var(--primary)';
                    btnJustify.style.color = 'var(--primary)';
                }
                btnJustify.onclick = () => justBox.classList.toggle('open');

                pendingBar.appendChild(forecastGroup);
                pendingBar.appendChild(btnJustify);
                pendingBar.appendChild(btnAttach);

                itemRight.appendChild(pendingBar);
                itemRight.appendChild(justBox); 
            }
            
            itemDiv.addEventListener('dragover', (e) => { e.preventDefault(); itemDiv.classList.add('drag-over'); });
            itemDiv.addEventListener('dragleave', (e) => { itemDiv.classList.remove('drag-over'); });
            itemDiv.addEventListener('drop', (e) => {
                e.preventDefault(); itemDiv.classList.remove('drag-over');
                if(!item.isNotApplicable && e.dataTransfer.files && e.dataTransfer.files.length > 0) window.handleFileUpload(item.id, e.dataTransfer.files);
            });
        }
    } else {
        if(!isRootFolder) {
            const mgmtFields = document.createElement('div');
            mgmtFields.className = 'management-fields';
            if (item.attachments && item.attachments.length > 0) {
                const valSelect = document.createElement('select');
                valSelect.className = 'input-modern btn-sm';
                ['Em Análise de APF', 'Validado', 'Apontamento'].forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt === 'Validado' ? 'APF check' : opt;
                    o.textContent = opt;
                    if(item.validationStatus === o.value || (opt === 'Validado' && item.validationStatus === 'Validado')) o.selected = true;
                    valSelect.appendChild(o);
                });
                valSelect.onchange = (e) => { 
                    const oldStatus = item.validationStatus;
                    item.validationStatus = e.target.value; 
                    saveState(); 
                    renderTree(); 
                    addAuditLog('Status de Validação', `Status de <strong>${item.name}</strong> alterado de "${oldStatus || 'Pendente'}" para "${item.validationStatus}"`, 'warning');
                };
                mgmtFields.appendChild(valSelect);

                if(item.validationStatus === 'Apontamento') {
                    const obsInp = document.createElement('input');
                    obsInp.type = 'text';
                    obsInp.className = 'input-modern btn-sm';
                    obsInp.placeholder = 'Qual apontamento?';
                    obsInp.value = item.observation || '';
                    obsInp.oninput = (e) => { 
                        item.observation = e.target.value; 
                        debouncedSave(); 
                    }; 
                    obsInp.onblur = () => renderTree();
                    mgmtFields.appendChild(obsInp);
                }
            } else {
                mgmtFields.style.display = 'flex';
                mgmtFields.style.alignItems = 'center';
                mgmtFields.style.gap = '1rem';

                const statusText = document.createElement('span');
                statusText.style.fontSize = '0.75rem';
                statusText.style.color = 'var(--text-muted)';
                statusText.style.fontStyle = 'italic';
                statusText.textContent = item.isNotApplicable ? 'Documento dispensado' : 'Aguardando documento...';

                const naLabel = document.createElement('label');
                naLabel.style.display = 'flex';
                naLabel.style.alignItems = 'center';
                naLabel.style.gap = '0.35rem';
                naLabel.style.fontSize = '0.75rem';
                naLabel.style.color = 'var(--text-muted)';
                naLabel.style.cursor = 'pointer';

                const naCheck = document.createElement('input');
                naCheck.type = 'checkbox';
                naCheck.className = 'input-modern';
                naCheck.style.width = 'auto';
                naCheck.style.accentColor = 'var(--text-muted)';
                naCheck.checked = !!item.isNotApplicable;
                naCheck.onchange = (e) => {
                    item.isNotApplicable = e.target.checked;
                    saveState();
                    updateGlobalDateUI();
                    renderTree();
                };

                naLabel.appendChild(naCheck);
                naLabel.appendChild(document.createTextNode('Não Obrigatório'));

                mgmtFields.appendChild(statusText);
                if (currProj && currProj.id !== 'p_default') {
                    mgmtFields.appendChild(naLabel);
                }
            }
            itemRight.appendChild(mgmtFields);
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '0.4rem';
        actionsDiv.style.alignItems = 'center';

        const btnAddSub = document.createElement('button');
        btnAddSub.className = 'btn btn-outline btn-sm';
        btnAddSub.innerHTML = '<i class="ph ph-folder-plus"></i> <span style="margin-left:5px">Subpasta</span>';
        btnAddSub.onclick = () => handleAddFolder(item.id);
        actionsDiv.appendChild(btnAddSub);

        const btnRename = document.createElement('button');
        btnRename.className = 'icon-btn';
        btnRename.innerHTML = '<i class="ph ph-pencil-simple"></i>';
        btnRename.onclick = () => handleRenameFolder(item.id);
        actionsDiv.appendChild(btnRename);

        const btnDel = document.createElement('button');
        btnDel.className = 'icon-btn delete';
        btnDel.innerHTML = '<i class="ph ph-trash"></i>';
        btnDel.onclick = () => handleDeleteFolder(item.id);
        actionsDiv.appendChild(btnDel);

        if(!isRootFolder && item.attachments && item.attachments.length > 0) {
            const inlineAttachments = document.createElement('div');
            inlineAttachments.className = 'inline-attachments-row';
            inlineAttachments.style.justifyContent = 'flex-end';
            
            item.attachments.forEach(att => {
                const attBadge = document.createElement('div');
                attBadge.className = 'inline-attachment';
                const nameTxt = document.createElement('span');
                nameTxt.className = 'text-truncate';
                nameTxt.style.maxWidth = '150px';
                nameTxt.textContent = att.name;

                const btnView = document.createElement('button');
                btnView.className = 'icon-btn';
                btnView.innerHTML = '<i class="ph ph-eye"></i>';
                btnView.onclick = () => window.openPreview(att);
                
                const btnAi = document.createElement('button');
                btnAi.className = 'icon-btn';
                btnAi.innerHTML = '<i class="ph ph-magic-wand text-primary"></i>';
                btnAi.onclick = () => window.analyzeDocumentAI(att);
                
                attBadge.appendChild(nameTxt);
                attBadge.appendChild(btnAi);
                attBadge.appendChild(btnView);
                inlineAttachments.appendChild(attBadge);
            });
            itemRight.appendChild(inlineAttachments);
        }
        itemRight.appendChild(actionsDiv);
    }

    itemDiv.appendChild(itemLeft);
    itemDiv.appendChild(itemRight);
    nodeWrapper.appendChild(itemDiv);

    if(!isMgmt && !isRootFolder && !hasChildren && item.validationStatus === 'Apontamento' && item.observation && item.attachments?.length > 0) {
        const obsBox = document.createElement('div');
        obsBox.className = 'observation-box';
        obsBox.innerHTML = `<strong><i class="ph ph-warning-circle"></i> Apontamento de APF:</strong> ${item.observation}`;
        const respArea = document.createElement('div');
        respArea.className = 'response-area';
        respArea.innerHTML = `<label class="response-label"><i class="ph ph-chat-text"></i> Resposta ao Apontamento</label>`;
        const respInput = document.createElement('textarea');
        respInput.className = 'response-input';
        respInput.placeholder = 'Escreva aqui a sua resposta...';
        respInput.value = item.response || '';
        respInput.onchange = (e) => { item.response = e.target.value; saveState(); };
        respArea.appendChild(respInput);
        obsBox.appendChild(respArea);
        nodeWrapper.appendChild(obsBox);
    }

    if(nodeChildren.length > 0) {
        const childCont = document.createElement('div');
        childCont.className = 'children-container';
        nodeChildren.forEach(c => {
            const childNode = createNode(c, level + 1);
            if(childNode) childCont.appendChild(childNode);
        });
        nodeWrapper.appendChild(childCont);
    }

    return nodeWrapper;
}

// Logic implementations
function handleAddFolder(parentId) {
    const parentItem = parentId ? getItems().find(i => i.id === parentId) : null;
    const name = prompt('Nome da nova pasta/item:');
    if(name && name.trim()){
        const item = {
            id: generateId(),
            name: name.trim(),
            parentId: parentId,
            protected: false,
            expanded: false,
            attachments: [],
            validationStatus: 'Em Análise de APF',
            observation: ''
        };

        // NEW: If creating a root folder (Sector), ask for password
        if (parentId === null) {
            const pass = prompt(`Defina uma senha para o novo setor "${name.trim()}":`, '1234');
            if (!state.settings) state.settings = {};
            if (!state.settings.sectorPasswords) state.settings.sectorPasswords = {};
            state.settings.sectorPasswords[name.trim()] = pass || '1234';
        }

        getItems().push(item);
        if(parentItem) parentItem.expanded = true;
        saveState();
        renderTree();
    }
}

function handleDeleteFolder(id) {
    if(confirm('Tem certeza que deseja excluir esta pasta e tudo dentro dela?')){
        const ids = new Set([id]);
        let foundNew;
        do {
            foundNew = false;
            getItems().forEach(i => {
                if(ids.has(i.parentId) && !ids.has(i.id)) { ids.add(i.id); foundNew = true; }
            });
        } while(foundNew);
        
        const proj = getCurrentProject();
        proj.items = proj.items.filter(i => !ids.has(i.id));
        saveState();
        renderTree();
    }
}

function handleRenameFolder(id) {
    const item = getItems().find(i => i.id === id);
    if(!item) return;
    const newName = prompt('Novo nome para a pasta/item:', item.name);
    if(newName && newName.trim() && newName.trim() !== item.name) {
        item.name = newName.trim();
        saveState();
        renderTree();
    }
}

// GESTÃO DE PENDÊNCIAS

function renderSectorPasswordsSettings() {
    const listCont = document.getElementById('sector-passwords-list');
    if (!listCont) return;

    if (!state.settings) state.settings = {};
    if (!state.settings.sectorPasswords) state.settings.sectorPasswords = { "APF": "1234" };

    const p = getCurrentProject() || state.projects.find(proj => proj.id === 'p_default');
    const rootSectors = ["APF", ...new Set(p.items.filter(i => i.parentId === null).map(i => i.name).sort())];

    listCont.innerHTML = '';
    rootSectors.forEach(s => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '0.5rem';
        
        const label = document.createElement('span');
        label.style.fontSize = '0.75rem';
        label.style.color = 'var(--text-main)';
        label.style.width = '120px';
        label.style.flexShrink = '0';
        label.className = 'text-truncate';
        label.textContent = s;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input-modern btn-sm';
        input.style.flex = '1';
        input.value = state.settings.sectorPasswords[s] || '1234';
        input.onchange = (e) => {
            state.settings.sectorPasswords[s] = e.target.value;
            saveState();
            addAuditLog('Senha Alterada', `Senha do setor <strong>${s}</strong> foi alterada.`, 'warning');
        };

        row.appendChild(label);
        row.appendChild(input);
        listCont.appendChild(row);
    });
}

function renderPendenciasMgmt() {
    const curr = getCurrentProject();
    const listCont = document.getElementById('pendencias-list-mgmt');
    const sectorSel = document.getElementById('new-pendencia-sector');
    if (!curr || !listCont) return;

    // Preserve current selection to avoid reset during auto-renders
    const savedSector = sectorSel ? sectorSel.value : '';

    // Populate sector dropdown
    if (sectorSel) {
        // Keep "Selecione" and "Outra"
        const defaultOptions = ['<option value="">Selecione o setor...</option>', '<option value="other">Outra...</option>'];
        
        // Find existing sectors (root folders)
        const items = getItems();
        const rootFolders = items.filter(i => i.parentId === null).map(i => i.name).sort();
        const uniqueSectors = [...new Set(rootFolders)];
        
        const optionsHtml = uniqueSectors.map(s => `<option value="${s}">${s}</option>`);
        sectorSel.innerHTML = [defaultOptions[0], ...optionsHtml, defaultOptions[1]].join('');
        
        // Restore selection if it still exists
        if (savedSector) sectorSel.value = savedSector;
    }

    pendenciaStartDateInp.value = curr.pendenciaStartDate || '';
    listCont.innerHTML = '';

    if (!curr.pendencias || curr.pendencias.length === 0) {
        listCont.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 1rem;">Nenhuma pendência crítica cadastrada.</p>';
        return;
    }

    curr.pendencias.forEach(p => {
        const row = document.createElement('div');
        row.className = 'pendencia-mgmt-row';
        if (editingPendenciaId === p.id) row.style.borderColor = 'var(--warning)';
        
        row.innerHTML = `
            <div style="display: flex; flex-direction: column; flex: 1;">
                <strong style="font-size: 0.85rem; color: white;">${p.docName}</strong>
                <span style="font-size: 0.7rem; color: var(--text-muted);">${p.sector}</span>
                ${p.specification ? `<span style="font-size: 0.7rem; color: var(--primary); font-style: italic;">Obs: ${p.specification}</span>` : ''}
            </div>
            
            <div style="display: flex; gap: 0.5rem; align-items: center;">
                <div class="mgmt-controls-group" style="display: flex; gap: 0.4rem; align-items: center;">
                    ${p.attachments && p.attachments.length > 0 ? `
                        <select class="input-modern btn-sm pendencia-val-select" style="max-width: 150px; padding: 0.2rem 0.4rem; font-size: 0.75rem;">
                            <option value="Em Análise de APF" ${p.validationStatus === 'Em Análise de APF' ? 'selected' : ''}>Em Análise</option>
                            <option value="APF check" ${p.validationStatus === 'APF check' || p.validationStatus === 'Validado' ? 'selected' : ''}>APF check</option>
                            <option value="Apontamento" ${p.validationStatus === 'Apontamento' ? 'selected' : ''}>Apontamento</option>
                        </select>
                        ${p.validationStatus === 'Apontamento' ? `
                            <input type="text" class="input-modern btn-sm pendencia-obs-inp" style="max-width: 150px; padding: 0.2rem 0.4rem; font-size: 0.75rem;" placeholder="Qual apontamento?" value="${p.observation || ''}">
                        ` : ''}
                    ` : '<span style="font-size: 0.7rem; color: var(--text-muted); font-style: italic;">Sem anexo</span>'}
                </div>

                <div style="display: flex; gap: 0.3rem;">
                    <button class="icon-btn edit" title="Editar Pendência">
                        <i class="ph ph-pencil-simple"></i>
                    </button>
                    <button class="icon-btn delete" title="Remover Pendência">
                        <i class="ph ph-trash"></i>
                    </button>
                </div>
            </div>
        `;
        
        row.querySelector('.edit').onclick = () => {
            editingPendenciaId = p.id;
            document.getElementById('new-pendencia-name').value = p.docName;
            
            const sectorSel = document.getElementById('new-pendencia-sector');
            const sectorOtherInp = document.getElementById('new-pendencia-sector-other');
            
            // Check if sector exists in dropdown
            let internalSector = false;
            for (let opt of sectorSel.options) {
                if (opt.value === p.sector) {
                    sectorSel.value = p.sector;
                    internalSector = true;
                    break;
                }
            }
            
            if (!internalSector) {
                sectorSel.value = 'other';
                sectorOtherInp.value = p.sector;
                sectorOtherInp.classList.remove('hidden');
            } else {
                sectorOtherInp.classList.add('hidden');
            }
            
            document.getElementById('new-pendencia-spec').value = p.specification || '';
            
            btnAddPendencia.innerHTML = '<i class="ph ph-check"></i> Salvar Alterações';
            btnAddPendencia.classList.remove('btn-danger');
            btnAddPendencia.classList.add('btn-warning');
            
            renderPendenciasMgmt(); // Re-render list to show active edit state
            document.getElementById('pendencias-mgmt-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        row.querySelector('.delete').onclick = () => {
            if (confirm('Deseja remover esta pendência?')) {
                if (editingPendenciaId === p.id) {
                     editingPendenciaId = null;
                     btnAddPendencia.innerHTML = '<i class="ph ph-plus"></i> Adicionar';
                     btnAddPendencia.classList.remove('btn-warning');
                     btnAddPendencia.classList.add('btn-danger');
                     document.getElementById('new-pendencia-name').value = '';
                     document.getElementById('new-pendencia-sector').value = '';
                     document.getElementById('new-pendencia-spec').value = '';
                }
                curr.pendencias = curr.pendencias.filter(item => item.id !== p.id);
                saveState();
                renderPendenciasMgmt();
                renderTree();
            }
        };
        listCont.appendChild(row);

        // Bind events for the new validation controls
        const valSel = row.querySelector('.pendencia-val-select');
        const obsInp = row.querySelector('.pendencia-obs-inp');

        if (valSel) {
            valSel.onchange = (e) => {
                p.validationStatus = e.target.value;
                saveState();
                renderPendenciasMgmt();
                renderTree();
            };
        }
        if (obsInp) {
            obsInp.oninput = (e) => { 
                const oldVal = p.observation || '';
                p.observation = e.target.value; 
                debouncedSave();
            };
            obsInp.onblur = () => {
                renderTree();
                if (p.observation) {
                     addAuditLog('Apontamento de Pendência', `Novo apontamento em <strong>${p.docName}</strong>: "${p.observation}"`, 'warning');
                }
            };
        }
    });
}

function sanitizePathSegment(segment) {
    if (!segment) return "";
    // Remove invalid Dropbox characters: / \ : ? * " < > |
    // Also trim and remove trailing spaces/dots which are problematic for some OS/sync systems
    return segment.replace(/[\/\\:\?\*\"<>\|]/g, '-').trim().replace(/[\. ]+$/, '');
}

function getItemPath(itemId, sanitize = false) {
    let path = [];
    let currentId = itemId;
    while(currentId) {
        const item = getItems().find(i => i.id === currentId);
        if(!item) break;
        const name = sanitize ? sanitizePathSegment(item.name) : item.name;
        path.unshift(name);
        currentId = item.parentId;
    }
    return path.join('/');
}

window.handleFileUpload = async function(itemId, files, isPendencia = false) {
    const currProject = getCurrentProject();
    if (!currProject || !files || files.length === 0) return;

    let targetItem;
    if (isPendencia) {
        targetItem = currProject.pendencias.find(p => p.id === itemId);
    } else {
        targetItem = getItems().find(i => i.id === itemId);
    }
    
    if(targetItem && currProject) {
        const sanitizedProjName = sanitizePathSegment(currProject.name);
        const folderPath = isPendencia ? 'PENDENCIAS' : getItemPath(itemId, true);
        document.body.style.cursor = 'wait';
        
        try {
            if(!targetItem.attachments) targetItem.attachments = [];
            
            for (const file of Array.from(files)) {
                const id = generateId();
                const sanitizedFileName = sanitizePathSegment(file.name);
                
                // Aplicar compressão se for imagem
                const fileToUpload = await compressImage(file);
                
                // Nova estrutura de caminho unificada no Firebase Storage
                const fbStoragePath = `APF_Projetos/${currProject.id}/${folderPath}/${id}-${sanitizedFileName}`;
                
                try {
                    // 1. Upload para Firebase Storage
                    const storageRef = ref(storage, fbStoragePath);
                    await uploadBytes(storageRef, fileToUpload);
                    
                    // 2. Obter URL de Download pública
                    const downloadUrl = await getDownloadURL(storageRef);
                    
                    targetItem.attachments.push({
                        id: id,
                        name: file.name,
                        type: file.type,
                        storagePath: fbStoragePath,
                        downloadUrl: downloadUrl,
                        objectUrl: downloadUrl,
                        source: 'firebase'
                    });

                    targetItem.validationStatus = 'Em Análise de APF';
                } catch (err) {
                    console.error("Erro no upload para o Firebase Storage", err);
                    alert(`Falha ao enviar '${file.name}' ao Firebase.`);
                }
            }
            saveState();
            renderTree();
            
            // Log Action
            const fileNames = Array.from(files).map(f => f.name).join(', ');
            addAuditLog('Documento Anexado', `Anexado(s) ${files.length} arquivo(s) em <strong>${targetItem.docName || targetItem.name}</strong>: ${fileNames}`, 'success');

            if (targetItem.attachments.length > 0) {
                const addedCount = files.length;
                const newAttachments = targetItem.attachments.slice(-addedCount);
                newAttachments.forEach((att, index) => {
                    const originalFile = files[index];
                    window.autoAnalyzeDocumentAI(att, itemId, originalFile, isPendencia);
                });
            }
        } finally {
            document.body.style.cursor = 'default';
        }
    }
}

window.handleDeleteFile = async function(itemId, fileId, isPendencia = false) {
    const currProject = getCurrentProject();
    if (!currProject) return;

    let targetItem;
    if (isPendencia) {
        targetItem = currProject.pendencias.find(p => p.id === itemId);
    } else {
        targetItem = getItems().find(i => i.id === itemId);
    }

    if(targetItem && targetItem.attachments){
        const att = targetItem.attachments.find(a => a.id === fileId);
        if (!att) return;

        if (!confirm(`Você tem certeza que deseja excluir o documento "${att.name}"?`)) return;

        try {
            // Caso 1: Arquivo Novo (Firebase Storage)
            if (att.storagePath) {
                const storageRef = ref(storage, att.storagePath);
                await deleteObject(storageRef);
                console.log("Arquivo removido do Firebase Storage.");
            }
            // Caso 2: Arquivo Legado (Dropbox)
            else if (att.dropboxPath && dbx) {
                await dbx.filesDeleteV2({ path: att.dropboxPath });
                console.log("Arquivo removido do Dropbox (Legado).");
            }
            
            const deletedFileName = att.name;
            targetItem.attachments = targetItem.attachments.filter(a => a.id !== fileId);
            saveState();
            renderTree();
            
            addAuditLog('Documento Excluído', `Removido <strong>${deletedFileName}</strong> de <strong>${targetItem.docName || targetItem.name}</strong>`, 'danger');
        } catch (err) {
            console.error("Erro ao excluir arquivo", err);
            // Mesmo com erro no storage, removemos do estado para não travar o UI
            targetItem.attachments = targetItem.attachments.filter(a => a.id !== fileId);
            saveState();
            renderTree();
        }
    }
}

// Global modal helpers
window.openPreview = function(fileObj) {
    const url = fileObj.downloadUrl || fileObj.dropboxUrl || fileObj.objectUrl;
    if (url) {
        window.open(url, '_blank');
    }
}


function initAIEngine() {
    const btnRefresh = document.getElementById('btn-refresh-analysis');
    if (btnRefresh) {
        btnRefresh.onclick = () => {
            btnRefresh.querySelector('i').style.animation = 'spin 0.6s linear';
            renderAnalysisPanels();
            setTimeout(() => { if (btnRefresh.querySelector('i')) btnRefresh.querySelector('i').style.animation = ''; }, 700);
        };
    }
}

function renderAnalysisPanels() {
    const sectorsEl = document.getElementById('panel-sectors');
    if (!sectorsEl) return;

    // ---- PAINEL: Análise por Setor (projeto selecionado) ----
    const nonBase = state.projects.filter(p => p.id !== 'p_default');
    const curr = getCurrentProject();
    if (!curr || curr.id === 'p_default' || nonBase.length === 0) {
        sectorsEl.innerHTML = '<div style="text-align:center; padding:1.25rem; color:var(--text-muted); font-size:0.82rem;"><i class="ph ph-chart-pie" style="font-size:1.5rem; opacity:0.4;"></i><br><br>Selecione um empreendimento para ver a análise por setor.</div>';
        return;
    }

    function getGrade(pct) {
        if (pct >= 90) return { g: 'A', color: 'var(--accent)', label: 'Excelente', bg: 'rgba(52,211,153,0.15)' };
        if (pct >= 70) return { g: 'B', color: '#60a5fa', label: 'Bom', bg: 'rgba(96,165,250,0.15)' };
        if (pct >= 50) return { g: 'C', color: 'var(--warning)', label: 'Regular', bg: 'rgba(245,158,11,0.15)' };
        if (pct >= 25) return { g: 'D', color: '#fb923c', label: 'Baixo', bg: 'rgba(251,146,60,0.15)' };
        return { g: 'F', color: 'var(--danger)', label: 'Crítico', bg: 'rgba(239,68,68,0.12)' };
    }

    const roots = curr.items.filter(i => i.parentId === null);
    if (roots.length === 0) {
        sectorsEl.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--text-muted); font-size:0.82rem;">Nenhum setor encontrado.</div>';
        return;
    }

    // Cabeçalho com nome do projeto em destaque no Painel
    const projHeader = `<div style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.8rem; padding-bottom:0.5rem; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; gap:0.4rem;">
        <i class="ph ph-buildings"></i>
        <span style="font-weight:700; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${curr.name}</span>
    </div>`;

    const sectorsHtml = roots.map(root => {
        let total = 0, delivered = 0, apontamentos = 0;
        const countItems = (itemId) => {
            curr.items.filter(i => i.parentId === itemId).forEach(child => {
                const hasChildren = curr.items.some(i => i.parentId === child.id);
                if (!hasChildren) {
                    total++;
                    if (child.attachments && child.attachments.length > 0) {
                        delivered++;
                        if (child.validationStatus === 'Apontamento') apontamentos++;
                    }
                }
                countItems(child.id);
            });
        };
        countItems(root.id);

        const pct = total > 0 ? Math.round((delivered / total) * 100) : 0;
        const grade = getGrade(pct);

        const showApontamentos = curr.pendenciaActive;

        const aponHtml = (showApontamentos && apontamentos > 0)
            ? `<div style="margin-top:0.3rem; font-size:0.68rem; color:var(--danger); display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-warning-circle"></i> ${apontamentos} apontamento(s) pendente(s)</div>`
            : '';

        let perfStatus = `No momento, o setor possui <strong>${pct}%</strong> da documentação indexada, o que o classifica com um status <strong>${grade.label}</strong>.`;
        if (pct === 100) perfStatus = `Excelente! O setor atingiu <strong>100%</strong> de entrega da documentação prevista, alcançando padrão <strong>${grade.label}</strong>.`;
        else if (pct < 50) perfStatus = `Atenção: o setor está com baixa adesão de documentos (<strong>${pct}%</strong>), classificado como <strong>${grade.label}</strong>. Recomendamos priorizar estas entregas.`;

        let pendStatus = '';
        if (showApontamentos) {
            pendStatus = apontamentos > 0 
                ? `<br><br><span style="color:var(--danger)"><i class="ph ph-warning-circle"></i> Há <strong>${apontamentos}</strong> documento(s) com apontamentos precisando de correção ou ressubmissão neste setor.</span>` 
                : `<br><br><span style="color:var(--accent)"><i class="ph ph-check-circle"></i> Não há apontamentos bloqueando este setor no momento.</span>`;
        }

        let resumo = `${perfStatus}${pendStatus}`;

        const resumoHtml = `
            <details class="ai-section" style="margin-top: 0.5rem; border: none; background: rgba(0,0,0,0.15);">
                <summary style="font-size: 0.75rem; color: var(--text-muted); padding: 0.4rem 0.6rem; background: transparent;"><i class="ph ph-info"></i> Resumo do setor</summary>
                <div class="ai-section-content" style="padding: 0.3rem 0.6rem 0.6rem; font-size: 0.75rem; color: var(--text-main); border-top: none; line-height: 1.4;">
                    ${resumo}
                </div>
            </details>
        `;

        return `
            <div style="padding:0.65rem 0.75rem; border-radius:0.5rem; margin-bottom:0.4rem; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.35rem; gap:0.5rem;">
                    <span style="font-size:0.8rem; font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display: flex; align-items: center; gap: 0.4rem;">
                        ${root.name}
                        ${(authenticatedSector !== 'APF' && authenticatedSector !== root.name) ? '<i class="ph ph-lock" style="font-size: 0.75rem; opacity: 0.5;" title="Acesso Restrito"></i>' : ''}
                    </span>
                    <span style="font-size:0.7rem; font-weight:800; color:${grade.color}; background:${grade.bg}; padding:0.15rem 0.45rem; border-radius:0.3rem; border:1px solid ${grade.color}44; white-space:nowrap;">${grade.g} - ${grade.label}</span>
                </div>
                <div style="height:4px; background:rgba(255,255,255,0.08); border-radius:2px; margin-bottom:0.35rem; overflow:hidden;">
                    <div style="height:100%; width:${pct}%; background:${grade.color}; border-radius:2px; transition:width 0.6s ease;"></div>
                </div>
                <div style="font-size:0.65rem; color:var(--text-muted); letter-spacing:0.02em;">${delivered}/${total} documentos entregues - ${pct}%</div>
                ${aponHtml}
                ${resumoHtml}
            </div>`;
    }).join('');

    sectorsEl.innerHTML = projHeader + sectorsHtml;
}



function initSettings() {
    const btnSettings = document.getElementById('btn-settings');
    const settingsModal = document.getElementById('settings-modal');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const btnResetModel = document.getElementById('btn-reset-model');
    
    const geminiModelInp = document.getElementById('settings-gemini-model');
    const geminiKeyInp = document.getElementById('settings-gemini-key');
    const btnToggleKey = document.getElementById('btn-toggle-key-visibility');
    
    const dbxKeyInp = document.getElementById('settings-dropbox-key');
    const apfPassInp = document.getElementById('settings-apf-password');

    if (!btnSettings) return;

    btnSettings.addEventListener('click', () => {
        geminiModelInp.value = localStorage.getItem('apf_gemini_model') || 'gemini-1.5-flash';
        geminiKeyInp.value = localStorage.getItem('apf_gemini_key') || '';
        dbxKeyInp.value = localStorage.getItem('apf_dropbox_app_key') || '';
        apfPassInp.value = localStorage.getItem('apf_access_password') || '';
        
        renderSectorPasswordsSettings();
        settingsModal.classList.remove('hidden');
    });

    if (btnSettings) {
        btnSettings.onclick = () => settingsModal.classList.remove('hidden');
    }

    // History Modal Events
    if (btnShowHistory) {
        btnShowHistory.onclick = () => {
            renderAuditLog();
            historyModal.classList.remove('hidden');
        };
    }
    if (btnCloseHistory) {
        btnCloseHistory.onclick = () => historyModal.classList.add('hidden');
    }
    if (historyModal) {
        historyModal.onclick = (e) => { if(e.target === historyModal) historyModal.classList.add('hidden'); };
    }

    btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
    settingsModal.addEventListener('click', (e) => { if(e.target === settingsModal) settingsModal.classList.add('hidden'); });

    btnResetModel.addEventListener('click', () => {
        geminiModelInp.value = 'gemini-1.5-flash';
        geminiModelInp.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        setTimeout(() => geminiModelInp.style.backgroundColor = '', 500);
    });

    btnToggleKey.addEventListener('click', () => {
        const isPass = geminiKeyInp.type === 'password';
        geminiKeyInp.type = isPass ? 'text' : 'password';
        btnToggleKey.innerHTML = `<i class="ph ph-eye${isPass ? '-slash' : ''}"></i>`;
    });

    const btnToggleDbxKey = document.getElementById('btn-toggle-dropbox-key-visibility');
    if (btnToggleDbxKey) {
        btnToggleDbxKey.addEventListener('click', () => {
            const isPass = dbxKeyInp.type === 'password';
            dbxKeyInp.type = isPass ? 'text' : 'password';
            btnToggleDbxKey.innerHTML = `<i class="ph ph-eye${isPass ? '-slash' : ''}"></i>`;
        });
    }

    btnSaveSettings.addEventListener('click', () => {
        const gModel = geminiModelInp.value.trim();
        const gKey = geminiKeyInp.value.trim();
        const aPass = apfPassInp.value.trim();

        if (gModel) localStorage.setItem('apf_gemini_model', gModel);
        if (gKey) localStorage.setItem('apf_gemini_key', gKey); else localStorage.removeItem('apf_gemini_key');
        if (aPass) localStorage.setItem('apf_access_password', aPass); else localStorage.removeItem('apf_access_password');

        alert('Configurações salvas com sucesso!');
        settingsModal.classList.add('hidden');
    });
}

window.analyzeDocumentAI = async function(att) {
    const { objectUrl: url, type: mimeType, name, dropboxPath } = att;
    document.getElementById('preview-title').textContent = `Leitura Robótica (IA): ${name}`;
    document.getElementById('preview-download-btn').style.display = 'none';
    const body = document.getElementById('preview-body');
    
    body.innerHTML = `
        <div style="text-align:center; padding:4rem; color:var(--primary);">
            <i class="ph ph-magic-wand ph-spin" style="font-size: 3rem; display:inline-block; animation-duration: 2s;"></i>
            <p style="margin-top:1rem;">O Gemini 1.5 está processando atributos textuais da sua captura neste momento...</p>
        </div>
    `;
    modalOverlay.classList.remove('hidden');

    try {
        let fileDataBase64 = '';
        
        // Try to get direct data from Dropbox if possible
        if (dropboxPath && dbx) {
            try {
                const response = await dbx.filesDownload({ path: dropboxPath });
                const blob = response.result.fileBlob;
                fileDataBase64 = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.readAsDataURL(blob);
                });
            } catch (dbxErr) {
                console.warn("Falha ao baixar do Dropbox, tentando via URL...", dbxErr);
            }
        }

        if (!fileDataBase64) {
            // URL direta (Firebase ou Dropbox validado)
            const fetchUrl = att.downloadUrl || url;
            const response = await fetch(fetchUrl);
            const blob = await response.blob();
            fileDataBase64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
            });
        }

        const apiKey = localStorage.getItem('apf_gemini_key');
        const modelName = localStorage.getItem('apf_gemini_model') || 'gemini-1.5-flash';
        if(!apiKey) {
            throw new Error("API Key não configurada. Por favor, acesse as Configurações (ícone ⚙️).");
        }
        // Fix: Using configured model name
        const aiUrl = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`;
        
        if(!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(mimeType)) {
            body.innerHTML = `<div style="padding: 2rem; color: var(--danger)"><i class="ph ph-warning" style="font-size: 2rem"></i><br>A extração visual Multimodal do Gemini 1.5 suporta especificamente leitura de imagens PDF nativas, JPG e PNG. O arquivo entregue apresenta extensão que o motor não compreende.</div>`;
            return;
        }

        const payload = {
            contents: [{
                parts: [
                    { text: "Verifique ou extraia um resumo inteligente deste documento/planta anexado sendo preciso e cirúrgico. Quais os pontos ou dados principais que você identifica listados nele?" },
                    { inline_data: { mime_type: mimeType, data: fileDataBase64 } }
                ]
            }]
        };

        const aiRes = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if(!aiRes.ok) {
            const isAuthErr = aiRes.status === 401 || aiRes.status === 403;
            if (isAuthErr) localStorage.removeItem('apf_gemini_key');
            throw new Error('Falha na autenticação ou processamento do Google (verifique o modelo e a chave).');
        }
        const data = await aiRes.json();
        const textOut = data.candidates[0].content.parts[0].text;
        
        const formattedHtml = textOut.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent);">$1</strong>').replace(/\n/g, '<br>');

        body.innerHTML = `<div style="text-align:left; color:white; font-size:0.95rem; line-height:1.6; padding: 1rem; width: 100%; white-space: break-spaces;">${formattedHtml}</div>`;
        
    } catch(e) {
        console.error(e);
        body.innerHTML = `<div style="padding:2rem; text-align:center; color:var(--danger)">
            <i class="ph ph-warning-circle" style="font-size: 2.5rem; margin-bottom: 1rem; display: block;"></i>
            <p>${e.message}</p>
            <p style="font-size: 0.8rem; margin-top: 1rem; opacity: 0.7;">Nota: Se o erro persistir com arquivos no Dropbox, tente recarregar a página ou reconectar o Dropbox.</p>
        </div>`;
    }
}

window.autoAnalyzeDocumentAI = async function(att, itemId, originalFile = null, isPendencia = false) {
    const { objectUrl: url, type: mimeType, name, dropboxPath } = att;
    const currProject = getCurrentProject();
    if (!currProject) return;

    try {
        let fileDataBase64 = '';
        
        // Caminho feliz: Temos acesso ao File original do upload (MUITO MAIS RÁPIDO E EVITA CORS)
        if (originalFile) {
            fileDataBase64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(originalFile);
            });
            console.log("IA usando arquivo original em memória.");
        }
        // Legado: Dropbox
        else if (dropboxPath && dbx) {
            try {
                const response = await dbx.filesDownload({ path: dropboxPath });
                const blob = response.result.fileBlob;
                fileDataBase64 = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.readAsDataURL(blob);
                });
            } catch (e) {
                console.warn("Falha ao baixar do Dropbox (auto AI)", e);
            }
        }

        // Fallback: Tentativa de baixar da URL (pode sofrer CORS dependendo das regras do Storage)
        if (!fileDataBase64) {
            console.log("IA baixando arquivo da URL (Fallback)...");
            const fetchUrl = att.downloadUrl || url;
            const response = await fetch(fetchUrl);
            const blob = await response.blob();
            fileDataBase64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
            });
        }

        const apiKey = localStorage.getItem('apf_gemini_key');
        const modelName = localStorage.getItem('apf_gemini_model') || 'gemini-1.5-flash'; // Standard model for auto-checks
        if (!apiKey) return;

        const aiUrl = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`;
        if (!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(mimeType)) return;

        const projectName = currProject.name;
        const payload = {
            contents: [{
                parts: [
                    { text: `O nome do empreendimento "${projectName}" consta explicitamente neste documento? Responda apenas Sim ou Não, seguido de uma breve explicação do local onde o nome foi encontrado ou por que não foi encontrado. Seja extremamente objetivo.` },
                    { inline_data: { mime_type: mimeType, data: fileDataBase64 } }
                ]
            }]
        };

        const aiRes = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (aiRes.ok) {
            const data = await aiRes.json();
            const textOut = data.candidates[0].content.parts[0].text;
            
            // Localizamos o item e o anexo novamente para garantir que estamos no estado atualizado
            const currentProj = getCurrentProject();
            if (!currentProj) return;

            let item;
            if (isPendencia) {
                item = currentProj.pendencias.find(p => p.id === itemId);
            } else {
                item = currentProj.items.find(i => i.id === itemId);
            }

            if (item && item.attachments) {
                const attachment = item.attachments.find(a => a.id === att.id);
                if (attachment) {
                    attachment.aiCheckResult = textOut.trim();
                    saveState();
                    renderTree();
                }
            }
        }
    } catch (e) {
        console.error("Auto AI Error:", e);
    }
}

// --- AUDIT LOG SYSTEM ---

function addAuditLog(action, details, type = 'info') {
    if (!state.auditLog) state.auditLog = [];
    const entry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        action,
        details,
        type,
        projectId: localUI.currentProjectId,
        projectName: getCurrentProject()?.name || 'Desconhecido'
    };
    state.auditLog.unshift(entry);
    // Limit to 200 items for performance
    if (state.auditLog.length > 200) state.auditLog = state.auditLog.slice(0, 200);
    saveState();
    renderAuditLog();
}

function renderAuditLog() {
    const container = document.getElementById('audit-log-container');
    if (!container) return;
    
    if (!state.auditLog || state.auditLog.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-muted); font-size: 0.55rem; font-weight: 700; padding: 2rem;">Nenhuma ação registrada ainda.</p>';
        return;
    }

    container.innerHTML = state.auditLog.map(log => {
        const date = new Date(log.timestamp);
        const timeStr = date.toLocaleString('pt-BR');
        let typeClass = '';
        if (log.type === 'danger') typeClass = 'danger';
        else if (log.type === 'warning') typeClass = 'warning';
        else if (log.type === 'success') typeClass = 'success';

        return `
            <div class="audit-entry ${typeClass}">
                <div class="audit-header">
                    <span class="audit-action">${log.action}</span>
                    <span class="audit-time">${timeStr}</span>
                </div>
                <div class="audit-details">
                    <span class="audit-project">${log.projectName}</span>
                    ${log.details}
                </div>
            </div>
        `;
    }).join('');
}
