// Firebase Imports
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot, getDoc, collection, query, where, serverTimestamp, deleteDoc } from "firebase/firestore";
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
let activeDevicesCount = 1;
let presenceUnsubscribe = null;

// Presence System
const DEVICE_ID_KEY = 'apf_device_id';
function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = generateId();
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
}

async function updatePresence() {
    const deviceId = getDeviceId();
    const docRef = doc(db, `presence/${deviceId}`);
    try {
        await setDoc(docRef, {
            lastSeen: serverTimestamp(),
            sector: authenticatedSector || 'Visitante',
            projectId: localUI.currentProjectId || 'none'
        });
    } catch (e) {
        console.warn("Erro ao atualizar presença:", e);
    }
}

function listenToActiveDevices() {
    // Apenas APF pode ver o contador (Otimização de leitura)
    if (authenticatedSector !== 'APF') {
        if (presenceUnsubscribe) {
            presenceUnsubscribe();
            presenceUnsubscribe = null;
        }
        return;
    }

    if (presenceUnsubscribe) return; // Já está escutando

    console.log("Iniciando monitoramento de dispositivos ativos...");
    const presenceCol = collection(db, 'presence');
    
    // Filtro: Atividade no último minuto (aproximado, o onSnapshot local filtrará o resto)
    // Nota: serverTimestamp() não funciona no where do query local de forma trivial sem o servidor, 
    // então pegamos todos e filtramos no cliente para maior precisão se necessário, 
    // mas o ideal é o query do Firestore.
    const q = query(presenceCol); 

    presenceUnsubscribe = onSnapshot(q, (snapshot) => {
        const now = Date.now();
        const threshold = 120 * 1000; // 120 segundos (mais tolerante)
        
        let count = 0;
        const processedIds = new Set();

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.lastSeen) {
                const lastSeenTime = data.lastSeen.toMillis ? data.lastSeen.toMillis() : now;
                if (now - lastSeenTime < threshold) {
                    count++;
                    processedIds.add(doc.id);
                }
            }
        });
        
        // Garantir que pelo menos o usuário atual (APF) seja contado se ele estiver ativo
        const myId = getDeviceId();
        if (!processedIds.has(myId)) {
            count++;
        }

        activeDevicesCount = count;
        
        const indicator = document.getElementById('presence-indicator');
        if (indicator) {
            indicator.innerHTML = `
                <span class="pulse-dot"></span>
                <span class="presence-text"><b>${activeDevicesCount}</b> dispositivos conectados</span>
            `;
            // Só exibe se estiver na aba de gestão
            indicator.style.display = isMgmtActive() ? 'flex' : 'none';
        }

        if (isMgmtActive()) {
            updateManagementStatsUI();
        }
    });
}

function loadLocalUI() {
    try {
        const saved = localStorage.getItem('apf_local_ui_v1');
        if (saved) {
            const parsed = JSON.parse(saved);
            localUI.expandedIds = new Set(); // Forçar colapso por padrão ao carregar
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

// Função Global de Confirmação Customizada
window.showConfirm = function({ title, message, confirmText, cancelText, type, onConfirm }) {
    if (!confirmModal) return;
    
    confirmModalTitle.textContent = title || 'Confirmar Ação';
    confirmModalMessage.textContent = message || 'Tem certeza que deseja continuar?';
    btnConfirmYes.textContent = confirmText || 'Sim, confirmar';
    btnConfirmNo.textContent = cancelText || 'Não, cancelar';
    
    // Reset display
    btnConfirmNo.style.display = 'block';

    // Icon e Estilo do Botão
    if (type === 'danger') {
        btnConfirmYes.className = 'btn btn-danger';
        confirmModalIconContainer.innerHTML = '<i class="ph ph-warning-circle" style="font-size: 3.5rem; color: var(--danger);"></i>';
    } else if (type === 'success') {
        btnConfirmYes.className = 'btn btn-primary';
        btnConfirmYes.style.background = 'var(--accent)';
        btnConfirmNo.style.display = 'none'; // Hide cancel button for success messages
        confirmModalIconContainer.innerHTML = '<i class="ph ph-check-circle" style="font-size: 3.5rem; color: var(--accent);"></i>';
    } else {
        btnConfirmYes.className = 'btn btn-primary';
        btnConfirmYes.style.background = '';
        confirmModalIconContainer.innerHTML = '<i class="ph ph-question" style="font-size: 3.5rem; color: var(--primary);"></i>';
    }
    
    confirmModal.classList.remove('hidden');
    
    const cleanup = () => {
        confirmModal.classList.add('hidden');
        btnConfirmYes.onclick = null;
        btnConfirmNo.onclick = null;
        btnConfirmYes.style.background = '';
    };
    
    btnConfirmYes.onclick = () => { cleanup(); if (onConfirm) onConfirm(); };
    btnConfirmNo.onclick = () => { cleanup(); };
};

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
    applyAuthState(); // Garante que a tela de login ou status de acesso sejam atualizados com os dados da nuvem
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
                            downloadUrl: att.downloadUrl || att.objectUrl || att.dropboxUrl || '',
                            objectUrl: att.downloadUrl || att.objectUrl || att.dropboxUrl || '',
                            source: att.source || 'firebase'
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
                                downloadUrl: att.downloadUrl || att.objectUrl || att.dropboxUrl || '',
                                objectUrl: att.downloadUrl || att.objectUrl || att.dropboxUrl || '',
                                source: att.source || 'firebase'
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
    const themeButtons = [
        document.getElementById('btn-theme-toggle'),
        document.getElementById('btn-login-theme-toggle')
    ];
    
    const isLight = document.documentElement.classList.contains('light-mode');
    const iconClass = isLight ? 'ph ph-moon' : 'ph ph-sun';
    const title = isLight ? 'Alternar para Modo Escuro' : 'Alternar para Modo Claro';

    themeButtons.forEach(btn => {
        if (btn) {
            btn.innerHTML = `<i class="${iconClass}"></i>`;
            btn.title = title;
        }
    });
}

function toggleTheme() {
    const htmlEl = document.documentElement;
    htmlEl.classList.toggle('light-mode');
    const isLight = htmlEl.classList.contains('light-mode');
    localStorage.setItem('apf_theme', isLight ? 'light' : 'dark');
    updateThemeIcon();
}

// DOM Elements
let btnNewProject, btnExportZip, btnExportPoints, btnToggleEng, btnDeleteProject, btnRenameProject, btnOpenTemplate, btnAddRoot;
let checklistContainer, sidebarApf, btnToggleSidebar, managementContainer, trackingContainer;
let tabs, tabContents, btnUnlock, btnBackToMain, inputPassword, passwordError, passwordLock, managementContent;
let btnSettings, btnSaveSettings, btnResetModel, geminiModelInp, geminiKeyInp, btnToggleKey, apfPassInp;
let btnTogglePendencias, pendenciasMgmtPanel, btnAddPendencia, pendenciaStartDateInp, modalOverlay, btnCloseModal;
let btnShowHistory, historyModal, btnCloseHistory;
let projectDueDateInp, currentProjectName, projectGlobalCountdown;
let globalLogin, loginSector;
let btnLogout, topAuthInfo, authNavTabs, btnLoginThemeToggle;
let btnMobileMenu, sidebarBackdrop;
let btnForgotPassword, forgotPasswordModal, btnCloseForgot;
let newProjectModal, btnCloseNewProject, btnConfirmNewProject, newProjNameInp, newProjUfInp, newProjCityInp;
let newProjectModalTitle, btnConfirmNewProjectText, newProjectModalInfo;
let editingProjectId = null;
let uploadToast, uploadToastText, uploadToastSub, uploadToastIcon;
let confirmModal, confirmModalTitle, confirmModalMessage, confirmModalIconContainer, btnConfirmYes, btnConfirmNo;

function initDOMElements() {
    // Auth
    globalLogin = document.getElementById('global-login');
    loginSector = document.getElementById('login-sector');
    topAuthInfo = document.getElementById('top-auth-info');
    authNavTabs = document.getElementById('auth-nav-tabs');
    btnLoginThemeToggle = document.getElementById('btn-login-theme-toggle');
    btnLogout = document.getElementById('btn-logout');
    btnMobileMenu = document.getElementById('btn-mobile-menu');
    sidebarBackdrop = document.getElementById('sidebar-backdrop');
    btnForgotPassword = document.getElementById('btn-forgot-password');
    forgotPasswordModal = document.getElementById('forgot-password-modal');
    btnCloseForgot = document.getElementById('btn-close-forgot');

    // Buttons
    btnNewProject = document.getElementById('btn-new-project');
    btnExportZip = document.getElementById('btn-export-zip');
    const btnReportsMenu = document.getElementById('btn-reports-menu');
    const reportsDropdown = document.getElementById('reports-dropdown');
    btnToggleEng = document.getElementById('btn-toggle-eng');
    btnDeleteProject = document.getElementById('btn-delete-project');
    btnRenameProject = document.getElementById('btn-rename-project');
    btnOpenTemplate = document.getElementById('btn-open-template');
    btnAddRoot = document.getElementById('btn-add-root');
    btnSettings = document.getElementById('btn-settings');
    
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

    // Settings elements
    btnSaveSettings = document.getElementById('btn-save-settings');
    btnResetModel = document.getElementById('btn-reset-model');
    geminiModelInp = document.getElementById('settings-gemini-model');
    geminiKeyInp = document.getElementById('settings-gemini-key');
    btnToggleKey = document.getElementById('btn-toggle-key-visibility');
    apfPassInp = document.getElementById('settings-apf-pass');

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
            showConfirm({
                title: 'Limpar Histórico',
                message: 'Tem certeza que deseja limpar permanentemente o histórico de ações? Esta operação não pode ser desfeita.',
                type: 'danger',
                confirmText: 'Limpar tudo',
                onConfirm: () => {
                    state.auditLog = [];
                    saveState();
                    renderAuditLog();
                    showTemporaryMessage("Histórico limpo com sucesso.");
                }
            });
        };
    }

    // New Project Modal
    newProjectModal = document.getElementById('new-project-modal');
    btnCloseNewProject = document.getElementById('btn-close-new-project');
    btnConfirmNewProject = document.getElementById('btn-confirm-new-project');
    newProjNameInp = document.getElementById('new-proj-name');
    newProjUfInp = document.getElementById('new-proj-uf');
    newProjCityInp = document.getElementById('new-proj-city');
    newProjectModalTitle = document.getElementById('new-project-modal-title');
    btnConfirmNewProjectText = document.getElementById('btn-confirm-new-project-text');
    newProjectModalInfo = document.getElementById('new-project-modal-info');

    // Upload Toast
    uploadToast = document.getElementById('upload-toast');
    uploadToastText = document.getElementById('upload-toast-text');
    uploadToastSub = document.getElementById('upload-toast-sub');
    uploadToastIcon = document.getElementById('upload-toast-icon');

    // Confirm Modal
    confirmModal = document.getElementById('confirm-modal');
    confirmModalTitle = document.getElementById('confirm-modal-title');
    confirmModalMessage = document.getElementById('confirm-modal-message');
    confirmModalIconContainer = document.getElementById('confirm-modal-icon-container');
    btnConfirmYes = document.getElementById('btn-confirm-yes');
    btnConfirmNo = document.getElementById('btn-confirm-no');
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    initDOMElements();
    loadLocalUI(); // Carrega IU local (pastas abertas, etc)
    
    // Theme setup
    if (localStorage.getItem('apf_theme') === 'light') {
        document.documentElement.classList.add('light-mode');
    }
    updateThemeIcon();

    initEventListeners();
    await loadState(); 
    
    // Check session after state is loaded (to populate sectors)
    applyAuthState(true);
    
    initAIEngine();
    initSettings();

    // Iniciar sistema de presença
    updatePresence();
    setInterval(updatePresence, 60 * 1000);
    
    // Limpeza ao sair (opcional, ajuda na precisão)
    window.addEventListener('beforeunload', () => {
        const deviceId = getDeviceId();
        const docRef = doc(db, `presence/${deviceId}`);
        // Nota: deleteDoc é assíncrono, pode não completar no beforeunload sem beacon, 
        // mas o timeout de 70s resolverá se falhar.
        deleteDoc(docRef);
    });
});

function initEventListeners() {
    const btnThemeToggle = document.getElementById('btn-theme-toggle');
    if (btnThemeToggle) {
        btnThemeToggle.addEventListener('click', toggleTheme);
    }
    
    if (btnLoginThemeToggle) {
        btnLoginThemeToggle.addEventListener('click', toggleTheme);
    }

    if (btnMobileMenu) {
        btnMobileMenu.addEventListener('click', () => {
            sidebarApf.classList.toggle('mobile-active');
            sidebarBackdrop.classList.toggle('active');
        });
    }

    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', () => {
            sidebarApf.classList.remove('mobile-active');
            sidebarBackdrop.classList.remove('active');
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
                
                applyAuthState(true);
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
        btnLogout.onclick = () => {
            showConfirm({
                title: 'Sair do Sistema',
                message: 'Deseja realmente encerrar sua sessão atual?',
                confirmText: 'Sair agora',
                onConfirm: () => {
                    logout();
                }
            });
        };
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

                if (tab.dataset.tab === 'management') {
                    listenToActiveDevices();
                }

                applyAuthState();
                updateGlobalDateUI();
                renderTree();
                renderTracking();
            });
        });
    }

    if (btnForgotPassword) {
        btnForgotPassword.onclick = () => {
            if (forgotPasswordModal) forgotPasswordModal.classList.remove('hidden');
        };
    }

    if (btnCloseForgot) {
        btnCloseForgot.onclick = () => {
            if (forgotPasswordModal) forgotPasswordModal.classList.add('hidden');
        };
    }

    if (forgotPasswordModal) {
        forgotPasswordModal.onclick = (e) => { if(e.target === forgotPasswordModal) forgotPasswordModal.classList.add('hidden'); };
    }

    // Sidebar & Project Management Listeners
    if (document.getElementById('btn-reports-menu')) {
        const btn = document.getElementById('btn-reports-menu');
        const dropdown = document.getElementById('reports-dropdown');
        btn.onclick = (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('hidden');
        };
        
        // Clique fora para fechar
        document.addEventListener('click', (e) => {
            if (!dropdown.classList.contains('hidden') && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.add('hidden');
            }
        });

        // Opções de relatório
        document.querySelectorAll('.report-opt').forEach(opt => {
            opt.onclick = () => {
                const mode = opt.dataset.mode;
                dropdown.classList.add('hidden');
                generateProjectReport(mode);
            };
        });
    }

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

    if (btnCloseNewProject) {
        btnCloseNewProject.onclick = () => newProjectModal.classList.add('hidden');
    }

    if (newProjectModal) {
        newProjectModal.onclick = (e) => { if(e.target === newProjectModal) newProjectModal.classList.add('hidden'); };
    }

    if (btnNewProject) {
        btnNewProject.addEventListener('click', () => {
            if (newProjectModal) {
                editingProjectId = null;
                if (newProjectModalTitle) newProjectModalTitle.innerHTML = '<i class="ph ph-plus-circle"></i> Novo Empreendimento';
                if (btnConfirmNewProjectText) btnConfirmNewProjectText.textContent = 'Criar Empreendimento';
                if (newProjectModalInfo) newProjectModalInfo.style.display = 'block';
                
                if (newProjNameInp) newProjNameInp.value = '';
                if (newProjUfInp) newProjUfInp.value = '';
                if (newProjCityInp) newProjCityInp.value = '';
                newProjectModal.classList.remove('hidden');
                if (newProjNameInp) newProjNameInp.focus();
            }
        });
    }

    if (btnConfirmNewProject) {
        btnConfirmNewProject.addEventListener('click', () => {
            const name = newProjNameInp.value.trim();
            const uf = newProjUfInp.value;
            const city = newProjCityInp.value.trim();

            if (!name) {
                alert('O nome do empreendimento é obrigatório.');
                return;
            }

            if (editingProjectId) {
                // Modo Edição
                const proj = state.projects.find(p => p.id === editingProjectId);
                if (proj) {
                    proj.name = name;
                    proj.uf = uf;
                    proj.cidade = city;
                    showTemporaryMessage(`Empreendimento "${name}" atualizado com sucesso!`);
                }
            } else {
                // Modo Criação
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
                    name: name,
                    uf: uf,
                    cidade: city,
                    dueDate: '',
                    engAnalysisOpened: false,
                    createdAt: new Date().toISOString().split('T')[0],
                    pendenciaActive: false,
                    pendencias: [],
                    items: duplicatedItems
                };

                state.projects.push(newProj);
                localUI.currentProjectId = newProj.id;
                localUI.expandedIds.clear();
                showTemporaryMessage(`Empreendimento "${name}" criado com sucesso!`);
            }
            
            newProjectModal.classList.add('hidden');
            
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
        });
    }

    if (btnExportZip) {
        btnExportZip.addEventListener('click', async () => {
            const curr = getCurrentProject();
            if (!curr || curr.id === 'none') {
                alert('Selecione um empreendimento primeiro.');
                return;
            }

            showConfirm({
                title: 'Baixar Documentação',
                message: `Você deseja baixar toda a documentação anexa do empreendimento ${curr.name}? O sistema irá processar os arquivos em um ZIP.`,
                confirmText: 'Baixar ZIP',
                onConfirm: async () => {
                    const originalBtnContent = btnExportZip.innerHTML;
                    btnExportZip.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Gerando ZIP...';
                    btnExportZip.disabled = true;
                    try {
                        const zip = new JSZip();
                        const rootFolder = zip.folder(curr.name);
                        async function processItem(item, parentFolder) {
                            const children = getItems().filter(i => i.parentId === item.id);
                            const attachments = item.attachments || [];
                            const hasDocs = attachments.length > 0;
                            const isFolder = children.length > 0;

                            // Se não for nada (nem pasta nem doc), ignora
                            if (!isFolder && !hasDocs) return;

                            // Criar a pasta para este item
                            const currentFolder = parentFolder.folder(item.name);

                            // Processar anexos
                            if (hasDocs) {
                                for (const att of attachments) {
                                    try {
                                        let url = null;

                                        // Tentar obter uma URL fresca se tivermos o caminho do storage (evita expiração de token)
                                        if (att.storagePath) {
                                            try {
                                                const storageRef = ref(storage, att.storagePath);
                                                url = await getDownloadURL(storageRef);
                                            } catch (urlErr) {
                                                console.warn(`Não foi possível gerar URL fresca para ${att.name}, tentando fallback...`, urlErr);
                                            }
                                        }

                                        // Fallback para URLs estáticas
                                        if (!url) {
                                            url = att.downloadUrl || att.objectUrl || att.dropboxUrl;
                                        }

                                        if (!url) {
                                            console.warn(`URL não encontrada para: ${att.name}`);
                                            continue;
                                        }

                                        const response = await fetch(url);
                                        if (!response.ok) throw new Error(`Status ${response.status}`);
                                        
                                        const blob = await response.blob();
                                        currentFolder.file(att.name, blob);
                                    } catch (e) {
                                        console.error(`Erro ao baixar "${att.name}" em "${item.name}":`, e);
                                    }
                                }
                            }

                            // Processar filhos recursivamente
                            for (const child of children) {
                                await processItem(child, currentFolder);
                            }
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
                }
            });
        });
    }

    if (btnExportPoints) {
        btnExportPoints.addEventListener('click', exportPointsReport);
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
            showConfirm({
                title: 'Excluir Empreendimento',
                message: `Tem certeza que deseja excluir permanentemente o empreendimento "${curr.name}" e todos os seus documentos?`,
                type: 'danger',
                confirmText: 'Excluir permanentemente',
                onConfirm: () => {
                    const nextProj = state.projects.find(p => p.id !== localUI.currentProjectId) || state.projects[0];
                    state.projects = state.projects.filter(p => p.id !== localUI.currentProjectId);
                    localUI.currentProjectId = nextProj.id;
                    saveLocalUI();
                    saveState();
                    updateGlobalDateUI();
                    renderTree();
                    renderTracking();
                    showTemporaryMessage(`Empreendimento removido.`);
                }
            });
        });
    }

    if (btnRenameProject) {
        btnRenameProject.addEventListener('click', () => {
            const curr = getCurrentProject();
            if (!curr || curr.id === 'p_default') return;

            if (newProjectModal) {
                editingProjectId = curr.id;
                if (newProjectModalTitle) newProjectModalTitle.innerHTML = '<i class="ph ph-pencil-simple"></i> Editar Empreendimento';
                if (btnConfirmNewProjectText) btnConfirmNewProjectText.textContent = 'Salvar Alterações';
                if (newProjectModalInfo) newProjectModalInfo.style.display = 'none';

                if (newProjNameInp) newProjNameInp.value = curr.name || '';
                if (newProjUfInp) newProjUfInp.value = curr.uf || '';
                if (newProjCityInp) newProjCityInp.value = curr.cidade || '';

                newProjectModal.classList.remove('hidden');
                if (newProjNameInp) newProjNameInp.focus();
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
            if (treeSearchQuery.length > 0 || treeSearchFilter !== 'all') {
                expandRelevantNodes();
            } else {
                // Ao limpar a busca manualmente pelo teclado, volta a ocultar tudo
                localUI.expandedIds.clear();
                saveLocalUI();
            }
            renderTree();
        });
    }

    if (btnClearSearch) {
        btnClearSearch.onclick = () => {
            searchInp.value = '';
            treeSearchQuery = '';
            btnClearSearch.style.display = 'none';
            localUI.expandedIds.clear(); // Colapsar pastas ao limpar busca
            saveLocalUI();
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


function showTemporaryMessage(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '2rem';
    toast.style.right = '2rem';
    toast.style.padding = '1rem 1.5rem';
    toast.style.borderRadius = '1rem';
    
    // Glassmorphism Style
    toast.style.background = type === 'danger' ? 'rgba(239, 68, 68, 0.9)' : 'rgba(16, 185, 129, 0.9)';
    toast.style.backdropFilter = 'blur(10px)';
    toast.style.border = '1px solid rgba(255, 255, 255, 0.2)';
    
    toast.style.color = 'white';
    toast.style.boxShadow = '0 15px 35px rgba(0,0,0,0.4)';
    toast.style.zIndex = '100000';
    toast.style.fontSize = '0.9rem';
    toast.style.fontWeight = '600';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '0.5rem';
    toast.style.transform = 'translateY(1rem)';
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    
    const iconName = type === 'danger' ? 'ph-warning-circle' : 'ph-check-circle';
    toast.innerHTML = `<i class="ph ${iconName}" style="font-size: 1.25rem;"></i> ${msg}`;
    
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
    
    // Try current project, then default project, then fallback to DEFAULT_ITEMS
    const p = getCurrentProject() || state.projects.find(proj => proj.id === 'p_default');
    const itemsSource = (p && p.items && p.items.length > 0) ? p.items : DEFAULT_ITEMS;

    // Root folders names from the tree
    const rootSectors = [...new Set(itemsSource.filter(i => i.parentId === null).map(i => i.name).sort())];
    
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


function applyAuthState(silentRedirect = false) {
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

    if (authenticatedSector !== 'APF') {
        const isCurrentlyMgmt = isMgmtActive();
        if (isCurrentlyMgmt || !document.getElementById('tab-checklist').classList.contains('active')) {
            // Force Checklist tab for non-APF
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            
            const checklistTab = document.getElementById('tab-checklist');
            if (checklistTab) {
                checklistTab.classList.add('active');
                checklistTab.style.display = ''; // Garante visibilidade
            }
            
            const checklistBtn = document.querySelector('[data-tab="checklist"]');
            if (checklistBtn) checklistBtn.classList.add('active');
            
            if (isCurrentlyMgmt && !silentRedirect) {
                showTemporaryMessage("Redirecionado: Você não possui permissão de APF.");
            }
        }
    }

    if (apfSubmenu) apfSubmenu.style.display = (isMgmt && authenticatedSector === 'APF') ? 'flex' : 'none';
    
    if (authNavTabs) {
        authNavTabs.style.display = (authenticatedSector === 'APF') ? 'flex' : 'none';
        if (authenticatedSector === 'APF' && isMgmt) {
            listenToActiveDevices();
        }
        
        // Sync active state of nav tabs
        const currentActiveTab = isMgmt ? 'management' : 'checklist';
        const tabBtns = authNavTabs.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            if (btn.dataset.tab === currentActiveTab) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    if (isMgmt) {
        managementContent.style.display = 'block';
        if (sidebarApf) sidebarApf.style.display = 'flex';
    } else {
        managementContent.style.display = 'none';
        if (sidebarApf) sidebarApf.style.display = 'flex';
    }

    // Update Top Auth Info
    if (topAuthInfo) {
        if (isAuthenticated) {
            topAuthInfo.style.display = 'flex';
            topAuthInfo.innerHTML = `
                <span class="auth-text-small">Você está logado no acesso (${authenticatedSector})</span>
                ${authenticatedSector !== 'APF' ? `
                <button id="btn-change-auth-pass" class="icon-btn-simple" title="Alterar Minha Senha" style="font-size: 0.75rem; margin-left: 0.5rem;">
                    <i class="ph ph-lock-key"></i>
                </button>
                ` : ''}
                <button id="btn-logout-sidebar" class="icon-btn-simple" title="Sair da Sessão" style="font-size: 0.75rem; margin-left: 0.25rem;">
                    <i class="ph ph-sign-out"></i>
                </button>
            `;
            const slout = document.getElementById('btn-logout-sidebar');
            if (slout) slout.onclick = () => {
                showConfirm({
                    title: 'Sair do Sistema',
                    message: 'Deseja realmente encerrar sua sessão atual?',
                    confirmText: 'Sair agora',
                    onConfirm: () => {
                        logout();
                    }
                });
            };

            const cpBtn = document.getElementById('btn-change-auth-pass');
            if (cpBtn) cpBtn.onclick = openChangePasswordModal;
        } else {
            topAuthInfo.style.display = 'none';
        }
    }
}

function logout() {
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
    
    applyAuthState(true);
    renderTree();
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

    const totalPointed = applicableItems.filter(i => {
        const hasAtt = i.attachments && i.attachments.length > 0;
        return hasAtt && i.validationStatus === 'Apontamento';
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
        
        // Auto-expand removido para manter as pastas ocultas por padrão conforme solicitado
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
            if(localUI.currentProjectId === p.id) {
                // Mesmo que já esteja selecionado, fecha a sidebar no mobile para mostrar o conteúdo
                if (window.innerWidth <= 992 && sidebarApf) {
                    sidebarApf.classList.remove('mobile-active');
                    if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
                }
                return;
            }
            localUI.currentProjectId = p.id;
            localUI.expandedIds.clear(); // Garantir que as pastas fiquem ocultas por padrão ao trocar de projeto
            saveLocalUI();
            updateGlobalDateUI();
            renderTree();
            renderTracking();
            triggerPanelAnimation();

            // Fechar sidebar no mobile após seleção
            if (window.innerWidth <= 992 && sidebarApf) {
                sidebarApf.classList.remove('mobile-active');
                if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
            }
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
                </div>
                ${(p.cidade || p.uf) ? `<div class="tk-location"><i class="ph ph-map-pin"></i> ${p.cidade || ''}${p.cidade && p.uf ? ' - ' : ''}${p.uf || ''}</div>` : ''}
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
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
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

    // Novo: Ajuste dinâmico de fonte para nomes longos
    setTimeout(adjustTreeFontSize, 0); 
}

function adjustTreeFontSize() {
    const names = document.querySelectorAll('.item-name');
    names.forEach(name => {
        name.style.fontSize = ''; // Reset para re-calcular
        
        let fontSize = 0.9;
        const minFontSize = 0.6; // Reduzido um pouco mais para garantir visibilidade
        const step = 0.02; // Passo menor para ajuste mais fino
        
        // Verifica transbordamento e reduz fonte
        if (name.scrollWidth > name.clientWidth) {
            while (name.scrollWidth > name.clientWidth && fontSize > minFontSize) {
                fontSize -= step;
                name.style.fontSize = fontSize + 'rem';
            }
        }
    });
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
        const isFolder = getChildItems(item.id).length > 0 || item.parentId === null;
        
        let matchesFilter = true;
        if (treeSearchFilter !== 'all') {
            if (isFolder) {
                matchesFilter = false;
            } else {
                if (treeSearchFilter === 'pendente') matchesFilter = !hasAtt && !item.isNotApplicable;
                else if (treeSearchFilter === 'apontamento') matchesFilter = hasAtt && item.validationStatus === 'Apontamento';
                else if (treeSearchFilter === 'validado') matchesFilter = (hasAtt && item.validationStatus === 'Validado') || item.isNotApplicable;
                else if (treeSearchFilter === 'analise') matchesFilter = hasAtt && item.validationStatus === 'Em Análise de APF';
            }
        }

        // An item should be shown if it matches OR if any of its children match
        const anyChildMatches = (nodeId) => {
            const nodeChildren = getItems().filter(i => i.parentId === nodeId);
            return nodeChildren.some(c => {
                const cMatches = c.name.toLowerCase().includes(treeSearchQuery);
                const cHasAtt = c.attachments && c.attachments.length > 0;
                const cIsFolder = getItems().some(i => i.parentId === c.id) || c.parentId === null;
                
                let cMatchesFilter = true;
                if (treeSearchFilter !== 'all') {
                    if (cIsFolder) {
                        cMatchesFilter = false;
                    } else {
                        if (treeSearchFilter === 'pendente') cMatchesFilter = !cHasAtt && !c.isNotApplicable;
                        else if (treeSearchFilter === 'apontamento') cMatchesFilter = cHasAtt && c.validationStatus === 'Apontamento';
                        else if (treeSearchFilter === 'validado') cMatchesFilter = (cHasAtt && c.validationStatus === 'Validado') || c.isNotApplicable;
                        else if (treeSearchFilter === 'analise') cMatchesFilter = cHasAtt && c.validationStatus === 'Em Análise de APF';
                    }
                }
                
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

    // APLICAR COR DE STATUS AO ÍCONE (Para documentos/pastas finais)
    if (!isRootFolder && !hasChildren) {
        let iconColor = 'var(--text-main)';
        const hasAtt = item.attachments && item.attachments.length > 0;

        if (item.isNotApplicable) {
            iconColor = 'var(--text-muted)';
        } else if (hasAtt) {
            if (item.validationStatus === 'Validado' || item.validationStatus === 'APF check') {
                iconColor = 'var(--accent)';
            } else if (item.validationStatus === 'Apontamento') {
                iconColor = 'var(--danger)';
            } else {
                // Em Análise ou Sem Status definido ainda com anexo
                iconColor = 'var(--warning)';
            }
        } else {
            // Pendente (Sem anexo e não é N/A) -> Vermelho conforme solicitado
            iconColor = 'var(--danger)';
        }
        icon.style.color = iconColor;
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name text-truncate';
    if(isRootFolder) nameSpan.classList.add('root-name'); 
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
        const isLocked = authenticatedSector && authenticatedSector !== 'APF' && authenticatedSector.trim() !== item.name.trim();

        const indicatorsCont = document.createElement('div');
        indicatorsCont.className = 'sector-indicators';

        if (totalAlerts > 0) {
            const circle = document.createElement('span');
            circle.className = 'pending-circle';
            circle.textContent = totalAlerts;
            circle.title = `${totalAlerts} item(s) com pendências ou apontamentos`;
            indicatorsCont.appendChild(circle);
        }

        if (indicatorsCont.children.length > 0) {
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

    // RESTAURADO: LOCK ICON FOR ROOT FOLDERS - Right Aligned
    if(isRootFolder && localUI.currentProjectId !== 'p_default') {
        const isLocked = authenticatedSector && authenticatedSector !== 'APF' && authenticatedSector.trim() !== item.name.trim();
        if (isLocked) {
            const lockIcon = document.createElement('i');
            lockIcon.className = 'ph ph-lock-simple';
            lockIcon.style.color = 'var(--text-muted)';
            lockIcon.style.opacity = '0.6';
            lockIcon.style.fontSize = '1.1rem';
            lockIcon.style.marginRight = '0.5rem';
            lockIcon.title = 'Acesso Restrito';
            itemRight.appendChild(lockIcon);
        }
    }

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

            if (item.isNotApplicable) {
                const naBadge = document.createElement('span');
                naBadge.className = 'badge badge-na badge-sm';
                naBadge.textContent = 'Não Necessário';
                statusRow.appendChild(naBadge);
            }

            const btnAttach = document.createElement('button');
            btnAttach.className = 'icon-btn attach-icon-btn';
            btnAttach.title = 'Anexar documento';
            btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
            btnAttach.onclick = () => fileInput.click();
            
            if (item.isNotApplicable) {
                btnAttach.disabled = true;
                btnAttach.style.opacity = '0.5';
                btnAttach.title = currProj.id === 'p_default' ? 'Anexar documento' : 'Documento dispensado';
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
                if(item.forecastDate) {
                    forecastInput.value = item.forecastDate;
                    forecastInput.classList.add('has-value');
                }
                forecastInput.onchange = (e) => { 
                    item.forecastDate = e.target.value; 
                    if(e.target.value) e.target.classList.add('has-value');
                    else e.target.classList.remove('has-value');
                    saveState(); 
                };
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
                const updateJustifyBtnStyle = () => {
                    if(item.justification && item.justification.trim() !== '') {
                        btnJustify.style.borderColor = 'var(--danger)';
                        btnJustify.style.color = 'var(--danger)';
                    } else {
                        btnJustify.style.borderColor = '';
                        btnJustify.style.color = '';
                    }
                };
                updateJustifyBtnStyle();

                justInput.oninput = (e) => { 
                    item.justification = e.target.value; 
                    updateJustifyBtnStyle(); 
                    if (typeof debouncedSave === 'function') debouncedSave();
                };
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
                statusText.textContent = (item.isNotApplicable && currProj.id !== 'p_default') ? 'Documento dispensado' : 'Aguardando documento...';

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
        btnAddSub.innerHTML = '<i class="ph ph-folder-plus"></i>';
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
    showConfirm({
        title: 'Excluir Pasta',
        message: 'Tem certeza que deseja excluir esta pasta e todo o seu conteúdo permanentemente?',
        type: 'danger',
        confirmText: 'Excluir tudo',
        onConfirm: () => {
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
            showTemporaryMessage("Pasta removida com sucesso.");
        }
    });
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
        input.value = (state.settings.sectorPasswords[s]) || '1234';
        input.onchange = (e) => {
            const val = e.target.value;
            state.settings.sectorPasswords[s] = val;
            
            // Se for APF, sincroniza com a senha da aba de gestão no localStorage
            if (s === 'APF') {
                localStorage.setItem('apf_access_password', val);
            }
            
            saveState();
            addAuditLog('Senha Alterada', `Senha do setor <strong>${s}</strong> foi alterada.`, 'warning');
            showTemporaryMessage(`Senha de ${s} atualizada com sucesso!`, "success");
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
            showConfirm({
                title: 'Remover Pendência',
                message: `Deseja remover a pendência "${p.docName}"?`,
                type: 'danger',
                confirmText: 'Remover',
                onConfirm: () => {
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
                    showTemporaryMessage("Pendência removida.");
                }
            });
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
    // Remove invalid characters for paths
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
        
        // Função auxiliar interna para atualizar o toast
        const updateToast = (state, title, subtitle) => {
            if (!uploadToast) return;
            uploadToast.classList.remove('hidden');
            if (uploadToastText) uploadToastText.textContent = title;
            if (uploadToastSub) uploadToastSub.textContent = subtitle;
            if (uploadToastIcon) {
                if (state === 'loading') {
                    uploadToastIcon.className = 'toast-spinner-mini';
                    uploadToastIcon.innerHTML = '';
                    uploadToast.style.borderColor = 'var(--primary)';
                } else if (state === 'success') {
                    uploadToastIcon.className = '';
                    uploadToastIcon.innerHTML = '<i class="ph ph-check-circle ph-bold" style="color: #10b981; font-size: 1.5rem;"></i>';
                    uploadToast.style.borderColor = '#10b981';
                } else if (state === 'error') {
                    uploadToastIcon.className = '';
                    uploadToastIcon.innerHTML = '<i class="ph ph-warning-circle ph-bold" style="color: #ef4444; font-size: 1.5rem;"></i>';
                    uploadToast.style.borderColor = '#ef4444';
                }
            }
        };

        updateToast('loading', 'Realizando upload...', 'Por favor, aguarde a conclusão.');
        
        let success = true;
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
                    success = false;
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
        } catch (globalErr) {
            success = false;
            console.error("Erro global no upload", globalErr);
        } finally {
            if (success) {
                updateToast('success', 'Upload concluído!', 'Arquivos salvos com sucesso.');
                setTimeout(() => uploadToast?.classList.add('hidden'), 3000);
            } else {
                updateToast('error', 'Erro no upload', 'Ocorreu um problema ao enviar os arquivos.');
                setTimeout(() => uploadToast?.classList.add('hidden'), 5000);
            }
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

        showConfirm({
            title: 'Excluir documento',
            message: `Você tem certeza que deseja excluir permanentemente o documento "${att.name}"?`,
            type: 'danger',
            confirmText: 'Excluir arquivo',
            onConfirm: async () => {
                try {
                    if (att.storagePath) {
                        const storageRef = ref(storage, att.storagePath);
                        await deleteObject(storageRef);
                    }
                    const deletedFileName = att.name;
                    targetItem.attachments = targetItem.attachments.filter(a => a.id !== fileId);
                    saveState();
                    renderTree();
                    addAuditLog('Documento Excluído', `Removido <strong>${deletedFileName}</strong> de <strong>${targetItem.docName || targetItem.name}</strong>`, 'danger');
                    showTemporaryMessage("Arquivo excluído.");
                } catch (err) {
                    console.error("Erro ao excluir arquivo", err);
                    targetItem.attachments = targetItem.attachments.filter(a => a.id !== fileId);
                    saveState();
                    renderTree();
                }
            }
        });
    }
}

// Global modal helpers
window.openPreview = function(fileObj) {
    const url = fileObj.downloadUrl || fileObj.objectUrl;
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

    const roots = curr.items.filter(i => i.parentId === null).sort((a, b) => a.name.localeCompare(b.name));
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
                    <div class="sector-name-wrapper">
                        <span class="sector-name-text">${root.name}</span>
                    </div>
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
    
    if (!btnSettings) return;

    btnSettings.onclick = () => {
        if (geminiModelInp) geminiModelInp.value = localStorage.getItem('apf_gemini_model') || 'gemini-1.5-flash';
        if (geminiKeyInp) geminiKeyInp.value = localStorage.getItem('apf_gemini_key') || '';
        
        renderSectorPasswordsSettings();
        if (settingsModal) settingsModal.classList.remove('hidden');
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
    const { objectUrl: url, type: mimeType, name } = att;
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
            <p style="font-size: 0.8rem; margin-top: 1rem; opacity: 0.7;">Nota: Verifique se sua chave de API do Gemini ainda é válida.</p>
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
        projectName: getCurrentProject()?.name || 'Desconhecido',
        sector: authenticatedSector || 'Sistema'
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
        const day = date.toLocaleDateString('pt-BR');
        const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        
        let typeClass = '';
        let iconAction = 'ph-info';
        if (log.type === 'danger') { typeClass = 'danger'; iconAction = 'ph-warning-circle'; }
        else if (log.type === 'warning') { typeClass = 'warning'; iconAction = 'ph-warning-diamond'; }
        else if (log.type === 'success') { typeClass = 'success'; iconAction = 'ph-check-circle'; }

        return `
            <div class="audit-entry ${typeClass}">
                <div class="audit-body">
                    <div class="audit-row-project">
                        <i class="ph ph-buildings"></i> <b>${log.projectName}</b>
                    </div>
                    <div class="audit-row-user">
                        <i class="ph ph-user-focus"></i> Responsável: <b>${log.sector || 'Sistema'}</b>
                    </div>
                    <div class="audit-row-action">
                        <i class="ph ${iconAction}"></i> ${log.action}
                    </div>
                    <div class="audit-row-time">
                        <i class="ph ph-clock"></i> ${time} | ${day}
                    </div>
                    <div class="audit-row-desc">
                        ${log.details}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}
function generateProjectReport(mode = 'only_points') {
    const curr = getCurrentProject();
    if (!curr || curr.id === 'none') {
        alert('Selecione um empreendimento primeiro.');
        return;
    }

    let reportTitle = "Relatório";
    let reportData = [];

    // Lógica de filtragem baseada no modo
    if (mode === 'eng_pendencies') {
        reportTitle = "Pendências de Engenharia";
        reportData = (curr.pendencias || []).map(p => ({
            id: p.id,
            name: p.docName,
            sector: p.sector,
            observation: p.observation || p.specification || 'Pendente de resolução...'
        }));
    } else {
        const allItems = curr.items || [];
        reportData = allItems.filter(i => {
            const hasChildren = allItems.some(child => child.parentId === i.id);
            if (i.parentId === null || hasChildren) return false; // Apenas folhas (documentos)
            if (i.isNotApplicable) return false;

            const isPointed = i.validationStatus === 'Apontamento';
            const isPendent = !i.attachments || i.attachments.length === 0;

            if (mode === 'only_points') {
                reportTitle = "Relatório de Apontamentos";
                return isPointed;
            } else if (mode === 'only_pendent') {
                reportTitle = "Documentos Pendentes";
                return isPendent;
            } else if (mode === 'all_pendent_pointed') {
                reportTitle = "Documentos Pendentes e Apontamentos";
                return isPendent || isPointed;
            }
            return false;
        });
    }

    if (reportData.length === 0) {
        alert('Não há dados para gerar este relatório com os filtros atuais.');
        return;
    }

    // Agrupar por setor (usando getItemSector para garantir o setor responsável pai)
    const grouped = {};
    reportData.forEach(item => {
        let sector = 'Geral';
        if (mode === 'eng_pendencies') {
            sector = item.sector || 'Geral';
        } else {
            sector = getItemSector(item.id) || item.sector || 'Geral';
        }
        
        if (!grouped[sector]) grouped[sector] = [];
        grouped[sector].push(item);
    });

    // Gerar HTML do relatório (Mantendo layout atual)
    const dateStr = new Date().toLocaleDateString('pt-BR');
    const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    
    let reportHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${reportTitle} - ${curr.name}</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Inter', sans-serif; line-height: 1.6; color: #333; padding: 40px; }
                .header { border-bottom: 2px solid #333; margin-bottom: 30px; padding-bottom: 10px; }
                .header h1 { margin: 0; font-size: 24px; color: #000; }
                .header p { margin: 5px 0 0; font-size: 14px; color: #666; }
                .sector-block { margin-top: 30px; page-break-inside: avoid; }
                .sector-title { background: #f4f4f5; padding: 8px 15px; border-left: 5px solid var(--primary, #1a1a1e); font-weight: 700; font-size: 16px; margin-bottom: 15px; text-transform: uppercase; }
                .item-row { margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee; }
                .item-name { font-weight: 600; font-size: 14px; display: block; margin-bottom: 4px; }
                .item-note { font-size: 13px; color: #444; padding-left: 20px; position: relative; }
                .item-note::before { content: '•'; position: absolute; left: 5px; color: #ef4444; font-weight: bold; }
                @media print {
                    body { padding: 0; }
                    .no-print { display: none; }
                }
                .no-print-btn { background: #1a1a1e; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: 600; margin-bottom: 20px; display: inline-flex; align-items: center; gap: 8px; }
            </style>
        </head>
        <body>
            <button class="no-print-btn no-print" onclick="window.print()">Imprimir / Salvar PDF</button>
            <div class="header">
                <h1>${reportTitle}</h1>
                <p>Empreendimento: <strong>${curr.name}</strong></p>
                <p>Data de Geração: ${dateStr} às ${timeStr}</p>
            </div>
    `;

    Object.keys(grouped).sort((a, b) => a.localeCompare(b)).forEach(sector => {
        reportHtml += `<div class="sector-block">
            <div class="sector-title">${sector}</div>`;
        
        grouped[sector].forEach(item => {
            reportHtml += `
                <div class="item-row">
                    <span class="item-name">${item.name}</span>
                    <div class="item-note">${item.observation || 'Nenhuma observação detalhada.'}</div>
                </div>
            `;
        });

        reportHtml += `</div>`;
    });

    reportHtml += `
        <div style="margin-top: 50px; font-size: 12px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px;">
            Documento gerado automaticamente pelo Sistema APF Checklist.
        </div>
    </body>
    </html>`;

    const printWin = window.open('', '_blank');
    printWin.document.write(reportHtml);
    printWin.document.close();
}

// --- PASSWORD CHANGE SYSTEM ---
function openChangePasswordModal() {
    const modal = document.getElementById('change-password-modal');
    if (modal) {
        document.getElementById('change-pass-current').value = '';
        document.getElementById('change-pass-new').value = '';
        document.getElementById('change-pass-confirm').value = '';
        modal.classList.remove('hidden');
    }
}

function closeChangePasswordModal() {
    const modal = document.getElementById('change-password-modal');
    if (modal) modal.classList.add('hidden');
}

async function processPasswordChange() {
    const currentInp = document.getElementById('change-pass-current');
    const newInp = document.getElementById('change-pass-new');
    const confirmInp = document.getElementById('change-pass-confirm');
    
    const currentPass = currentInp.value.trim();
    const newPass = newInp.value.trim();
    const confirmPass = confirmInp.value.trim();
    
    if (!currentPass || !newPass || !confirmPass) {
        showTemporaryMessage("Por favor, preencha todos os campos.", "danger");
        return;
    }
    
    if (newPass.length < 4) {
        showTemporaryMessage("A nova senha deve ter pelo menos 4 caracteres.", "danger");
        return;
    }
    
    if (newPass !== confirmPass) {
        showTemporaryMessage("A nova senha e a confirmação não coincidem.", "danger");
        return;
    }
    
    const storedPasswords = state.settings?.sectorPasswords || {};
    const correctCurrent = storedPasswords[authenticatedSector] || "1234";
    
    if (currentPass !== correctCurrent) {
        showTemporaryMessage("A senha atual digitada está incorreta.", "danger");
        currentInp.style.borderColor = 'var(--danger)';
        setTimeout(() => currentInp.style.borderColor = '', 1500);
        currentInp.focus();
        return;
    }
    
    try {
        if (!state.settings) state.settings = {};
        if (!state.settings.sectorPasswords) state.settings.sectorPasswords = {};
        
        state.settings.sectorPasswords[authenticatedSector] = newPass;
        saveState();
        
        addAuditLog('Senha Alterada', `O setor <strong>${authenticatedSector}</strong> alterou sua própria senha de acesso.`, 'warning');
        closeChangePasswordModal();
        
        // Mensagem de Confirmação Robusta
        setTimeout(() => {
            showConfirm({
                title: 'Senha Atualizada',
                message: 'Sua senha foi alterada com sucesso! Utilize-a em seu próximo login.',
                confirmText: 'Entendido',
                type: 'success'
            });
        }, 300);
    } catch (e) {
        console.error("Erro ao alterar senha:", e);
        showTemporaryMessage("Erro técnico ao salvar senha. Tente novamente.", "danger");
    }
}

// Inicializar eventos do novo modal (chamado após o carregamento do DOM)
document.addEventListener('DOMContentLoaded', () => {
    const btnClose = document.getElementById('btn-close-change-pass');
    if (btnClose) btnClose.onclick = closeChangePasswordModal;

    const btnSave = document.getElementById('btn-save-change-pass');
    if (btnSave) btnSave.onclick = processPasswordChange;

    const modal = document.getElementById('change-password-modal');
    if (modal) {
        modal.onclick = (e) => { if (e.target === modal) closeChangePasswordModal(); };
    }
});
