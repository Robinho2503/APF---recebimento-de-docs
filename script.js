// Firebase Imports
console.log("APF Script: Iniciando carregamento...");
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot, getDoc, getDocs, collection, query, where, serverTimestamp, deleteDoc, enableIndexedDbPersistence, runTransaction } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject, getMetadata, listAll } from "firebase/storage";

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

// Ativar Persistência Local (Sugestão 4)
try {
    enableIndexedDbPersistence(db).catch((err) => {
        if (err.code == 'failed-precondition') {
            console.warn("Múltiplas abas abertas, persistência desativada.");
        } else if (err.code == 'unimplemented') {
            console.warn("Navegador não suporta persistência.");
        }
    });
} catch (e) { }

const storage = getStorage(app);
const GLOBAL_DOC_PATH = "apf_data/v2_global_state";

// URL do Webhook do Microsoft Teams (Unificada para todos os setores)
const TEAMS_WEBHOOK_URL = "https://vianaemoura.webhook.office.com/webhookb2/1054365b-3fda-40bd-8ae4-7a6175d61b96@63c474e6-d8b2-4c52-a134-94ca3d624634/IncomingWebhook/00c2f490ae2b4329be065272ea3bd166/e0b9de19-0895-47e1-aaa6-0b0f9c07d374/V29kyRlQjiZzRL4sIhHwUJlC8USHvDi7PEFvFpQFPIjbs1";

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
    expandedPendenciasSectors: new Set(),
    expandedMgmtPendenciasSectors: new Set(),
    showFullChecklistDuringPendencia: false,
    currentProjectId: null,
    sidebarCollapsed: false,
    showHistorySidebar: false
};
let treeSearchQuery = '';
let treeSearchFilter = 'all'; // all, pendente, apontamento
let activeDevicesCount = 1;
let presenceUnsubscribe = null;
let globalFileInput = null;
let activeUploadItemId = null;
let isUploadPendencia = false;

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

        updateGlobalDateUI();
        const p = getCurrentProject();
        if (p) updateProjectProgressUI(p);
    });
}

function loadLocalUI() {
    try {
        const saved = localStorage.getItem('apf_local_ui_v1');
        if (saved) {
            localUI = JSON.parse(saved);
            // Ensure expandedIds, expandedPendenciasSectors and expandedMgmtPendenciasSectors are Sets
            localUI.expandedIds = new Set(localUI.expandedIds || []);
            localUI.expandedPendenciasSectors = new Set(localUI.expandedPendenciasSectors || []);
            localUI.expandedMgmtPendenciasSectors = new Set(localUI.expandedMgmtPendenciasSectors || []);
            localUI.showHistorySidebar = !!localUI.showHistorySidebar;
        }
    } catch (e) { console.warn("Erro ao carregar IU local", e); }
}

function saveLocalUI() {
    const toSave = {
        expandedIds: Array.from(localUI.expandedIds),
        expandedPendenciasSectors: Array.from(localUI.expandedPendenciasSectors || []),
        expandedMgmtPendenciasSectors: Array.from(localUI.expandedMgmtPendenciasSectors || []),
        showFullChecklistDuringPendencia: localUI.showFullChecklistDuringPendencia,
        currentProjectId: localUI.currentProjectId,
        sidebarCollapsed: localUI.sidebarCollapsed,
        showHistorySidebar: localUI.showHistorySidebar
    };
    localStorage.setItem('apf_local_ui_v1', JSON.stringify(toSave));
}



// Helpers
function generateId() { return Math.random().toString(36).substr(2, 9); }
function getCurrentProject() { return state.projects.find(p => p.id === localUI.currentProjectId); }
function getItems() { return getCurrentProject()?.items || []; }
function isMgmtActive() {
    return authenticatedSector === 'APF';
}



function getItemSector(itemId) {
    const p = getCurrentProject();
    if (!p) return null;
    let item = (p.items || []).find(i => i.id === itemId);
    if (!item) return null;

    let current = item;
    while (current && current.parentId !== null) {
        current = (p.items || []).find(i => i.id === current.parentId);
    }
    return current ? current.name : null;
}

function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Função Global de Confirmação Customizada
window.showConfirm = function ({ title, message, confirmText, cancelText, type, onConfirm }) {
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
let lastKnownRemoteProjects = {};

function cacheRemoteProject(proj) {
    if (!proj) return;
    lastKnownRemoteProjects[proj.id] = JSON.stringify(proj);
}

async function loadState() {
    // 1. First, check if there's local cache for instant load
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
        try {
            state = JSON.parse(cached);
            console.log("Loaded from local cache.");
            renderAfterUpdate();
        } catch (e) { console.warn("Cache error", e); }
    }

    // 2. Sincronizar com o Cloud em segundo plano (Não-bloqueante)
    syncWithCloud();
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

            // Garantir existência do Modelo de Entrega no índice global
            if (!cloudData.projects.find(p => p.id === 'p_default')) {
                cloudData.projects.unshift({
                    id: 'p_default',
                    name: 'Modelo de Entrega',
                    items: JSON.parse(JSON.stringify(DEFAULT_ITEMS)),
                    dueDate: '',
                    createdAt: new Date().toISOString().split('T')[0],
                    engAnalysisOpened: false,
                    pendencias: [],
                    pendenciaStartDate: ''
                });
            }
            
            if (cloudData.storageBytes === undefined) cloudData.storageBytes = 0;
            if (cloudData.storageFileCount === undefined) cloudData.storageFileCount = 0;

            state = cloudData;
            localStorage.setItem(CACHE_KEY, JSON.stringify(state)); // Update cache

            if (isInitialCloudLoad) {
                isInitialCloudLoad = false;
                const found = state.projects.find(p => p.id === localUI.currentProjectId);
                if (!found) {
                    localUI.currentProjectId = null;
                } else if (localUI.currentProjectId) {
                    // Restaurar projeto ativo (incluindo Modelo de Entrega)
                    console.log(`Restaurando projeto ativo: ${localUI.currentProjectId}`);
                    await selectProject(localUI.currentProjectId);
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

        // Verificação adicional de recuperação (caso o doc monolithic esteja vazio por conta da migração anterior)
        await checkAndRecoverData();

    } catch (e) {
        console.error("Cloud sync error:", e);
    }
}

function renderAfterUpdate() {
    renderTracking();
    updateGlobalDateUI();
    renderTree();
    updateThemeIcon();
    renderAuditLog();
    renderProjectHistory();
    applyAuthState();
    applySidebarState();
    updateFirebaseStorageUI();
}

let dirtyProjectIds = new Set();
let saveTimeout = null;

function saveState() {
    // Adicionar síncronamente o projeto atual modificado à lista de salvamento pendente
    const curr = getCurrentProject();
    if (curr && curr.id !== 'none' && curr.id !== 'p_default') {
        dirtyProjectIds.add(curr.id);
    }

    if (saveTimeout) clearTimeout(saveTimeout);

    // Aumento de Debounce para 2000ms (Sugestão 2)
    saveTimeout = setTimeout(async () => {
        console.log("Sincronizando com o cloud...");

        // 1. Salvar todos os projetos modificados (Surgidos por race condition)
        const idsToSave = Array.from(dirtyProjectIds);
        dirtyProjectIds.clear(); // Limpar a fila antes de iniciar as escritas assíncronas

        for (const id of idsToSave) {
            const proj = state.projects.find(p => p.id === id);
            if (proj) {
                // Calcular e salvar o tamanho do projeto antes de enviar ao Firestore
                let projBytes = 0;
                let projFiles = 0;
                const items = proj.items || [];
                items.forEach(item => {
                    const attachments = item.attachments || [];
                    attachments.forEach(att => {
                        projFiles++;
                        if (att.size !== undefined && typeof att.size === 'number') {
                            projBytes += att.size;
                        }
                    });
                });
                const pends = proj.pendencias || [];
                pends.forEach(p => {
                    const attachments = p.attachments || [];
                    attachments.forEach(att => {
                        projFiles++;
                        if (att.size !== undefined && typeof att.size === 'number') {
                            projBytes += att.size;
                        }
                    });
                });
                proj.storageBytes = projBytes;
                proj.storageFileCount = projFiles;
                proj.progressPct = getProjectProgress(proj);

                const projectDocRef = doc(db, `projects/${id}`);
                try {
                    const mergedProj = await runTransaction(db, async (transaction) => {
                        const pDoc = await transaction.get(projectDocRef);
                        if (!pDoc.exists()) {
                            transaction.set(projectDocRef, proj);
                            return proj;
                        }
                        const remoteProj = pDoc.data();
                        const lastKnownStr = lastKnownRemoteProjects[id];
                        let lastKnownProj = lastKnownStr ? JSON.parse(lastKnownStr) : null;
                        
                        if (lastKnownProj) {
                            (proj.items || []).forEach(localItem => {
                                const knownItem = (lastKnownProj.items || []).find(i => i.id === localItem.id);
                                if (!knownItem || JSON.stringify(localItem) !== JSON.stringify(knownItem)) {
                                    const remoteIdx = (remoteProj.items || []).findIndex(i => i.id === localItem.id);
                                    if (remoteIdx >= 0) remoteProj.items[remoteIdx] = localItem;
                                    else {
                                        if(!remoteProj.items) remoteProj.items = [];
                                        remoteProj.items.push(localItem);
                                    }
                                }
                            });
                            
                            (proj.pendencias || []).forEach(localPend => {
                                const knownPend = (lastKnownProj.pendencias || []).find(i => i.id === localPend.id);
                                if (!knownPend || JSON.stringify(localPend) !== JSON.stringify(knownPend)) {
                                    const remoteIdx = (remoteProj.pendencias || []).findIndex(i => i.id === localPend.id);
                                    if (remoteIdx >= 0) remoteProj.pendencias[remoteIdx] = localPend;
                                    else {
                                        if(!remoteProj.pendencias) remoteProj.pendencias = [];
                                        remoteProj.pendencias.push(localPend);
                                    }
                                }
                            });
                        } else {
                            remoteProj.items = proj.items || [];
                            remoteProj.pendencias = proj.pendencias || [];
                        }
                        
                        remoteProj.storageBytes = proj.storageBytes;
                        remoteProj.storageFileCount = proj.storageFileCount;
                        remoteProj.progressPct = getProjectProgress(remoteProj);
                        if (lastKnownProj && proj.engAnalysisOpened !== lastKnownProj.engAnalysisOpened) {
                            remoteProj.engAnalysisOpened = proj.engAnalysisOpened;
                        }
                        
                        transaction.set(projectDocRef, remoteProj);
                        return remoteProj;
                    });
                    
                    if (mergedProj) {
                        cacheRemoteProject(mergedProj);
                    }
                    console.log(`Projeto ${id} individual sincronizado de forma granular.`);
                } catch (e) {
                    console.error(`Erro ao salvar projeto individual ${id} via transação:`, e);
                }
            }
        }

        // 2. Salvar o Registro Global (Índice) sem os itens pesados (Sugestão 3)
        const globalDocRef = doc(db, GLOBAL_DOC_PATH);
        const indexState = {
            projects: state.projects.map(p => {
                const { items, ...metadata } = p;
                return {
                    ...metadata,
                    progressPct: p.id !== 'p_default' ? (p.items ? getProjectProgress(p) : (p.progressPct || 0)) : 0,
                    // Mantemos as estatísticas no índice para o sidebar
                    stats: p.id !== 'p_default' ? calculateProjectStats(p) : { pendente: 0, apontamento: 0 }
                };
            }),
            settings: state.settings || {},
            auditLog: (state.auditLog || []).slice(-100), // Limitar histórico no cloud para 100 itens
            storageBytes: state.storageBytes || 0,
            storageFileCount: state.storageFileCount || 0
        };

        // Cache local completo
        localStorage.setItem(CACHE_KEY, JSON.stringify(state));

        try {
            await setDoc(globalDocRef, indexState);
            console.log("Índice global sincronizado.");
        } catch (e) { console.error("Erro ao sincronizar índice:", e); }
    }, 2000);
}

async function selectProject(projectId) {
    const project = state.projects.find(p => p.id === projectId);
    if (!project) return;

    const isNewSelection = localUI.currentProjectId !== projectId;

    // Se o projeto já é o atual E já possui itens, ignoramos para evitar redundância
    if (!isNewSelection && (project.items || []).length > 0) return;

    // Sempre carregar/atualizar os dados do Firestore se for uma nova seleção ou se não tiver itens carregados
    if ((isNewSelection || !(project.items || []).length) && projectId !== 'none') {
        console.log(`Carregando/atualizando detalhes do projeto ${projectId}...`);
        const projectDocRef = doc(db, `projects/${projectId}`);
        try {
            const snap = await getDoc(projectDocRef);
            if (snap.exists()) {
                const fullData = snap.data();
                project.items = fullData.items || [];
                // Sincronizar metadados e outros campos do detalhe
                Object.assign(project, fullData);
                cacheRemoteProject(project);
            } else if (projectId === 'p_default') {
                // Fallback para o Modelo Padrão caso não exista no cloud
                console.log("Modelo no Cloud não encontrado, usando padrão local.");
                project.items = JSON.parse(JSON.stringify(DEFAULT_ITEMS));
                cacheRemoteProject(project);
            }
        } catch (e) {
            console.error("Erro ao carregar detalhes do projeto:", e);
            if (projectId === 'p_default') {
                project.items = JSON.parse(JSON.stringify(DEFAULT_ITEMS));
            } else {
                return;
            }
        }
    }

    localUI.currentProjectId = projectId;
    if (isNewSelection) {
        localUI.expandedIds.clear();
    }
    saveLocalUI();
    renderAfterUpdate();
    triggerPanelAnimation();

    if (window.innerWidth <= 992) {
        localUI.sidebarCollapsed = true;
        saveLocalUI();
        applySidebarState();
    }
    setupProjectRealtimeListener(projectId);
}

let activeProjectUnsubscribe = null;
function setupProjectRealtimeListener(projectId) {
    if (activeProjectUnsubscribe) {
        activeProjectUnsubscribe();
        activeProjectUnsubscribe = null;
    }

    if (projectId && projectId !== 'none' && projectId !== 'p_default') {
        const projectDocRef = doc(db, `projects/${projectId}`);
        activeProjectUnsubscribe = onSnapshot(projectDocRef, (snap) => {
            if (snap.exists()) {
                const fullData = snap.data();
                const lastKnownStr = lastKnownRemoteProjects[projectId];
                
                if (lastKnownStr) {
                    const lastKnown = JSON.parse(lastKnownStr);
                    const remoteItemsStr = JSON.stringify(fullData.items || []);
                    const knownItemsStr = JSON.stringify(lastKnown.items || []);
                    const remotePendsStr = JSON.stringify(fullData.pendencias || []);
                    const knownPendsStr = JSON.stringify(lastKnown.pendencias || []);
                    
                    if (remoteItemsStr !== knownItemsStr || remotePendsStr !== knownPendsStr) {
                        // Outro usuário ou aba fez modificações!
                        showUpdateNotification(projectId, fullData);
                    }
                }
            }
        });
    }
}

function showUpdateNotification(projectId, newData) {
    let toast = document.getElementById('update-notification-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'update-notification-toast';
        toast.style.position = 'fixed';
        toast.style.bottom = '30px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.background = 'var(--accent)';
        toast.style.color = '#ffffff';
        toast.style.padding = '12px 24px';
        toast.style.borderRadius = '30px';
        toast.style.fontWeight = '700';
        toast.style.boxShadow = '0 8px 25px rgba(0,0,0,0.3)';
        toast.style.zIndex = '99999';
        toast.style.cursor = 'pointer';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '10px';
        toast.innerHTML = '<i class="ph ph-arrows-clockwise" style="font-size:1.3rem;"></i> <span>Novas alterações detectadas. Clique para atualizar a tela.</span>';
        document.body.appendChild(toast);
    }
    
    toast.style.display = 'flex';
    
    toast.onclick = () => {
        const project = state.projects.find(p => p.id === projectId);
        if (project) {
            // Se houver conflitos não salvos localmente, eles serão sobrescritos pela versão da nuvem 
            // no momento do clique, mas isso garante que você receba os anexos e status novos.
            project.items = newData.items || [];
            project.pendencias = newData.pendencias || [];
            Object.assign(project, newData);
            cacheRemoteProject(project);
            
            // Remove the project from dirty ids so it doesn't immediately overwrite again
            dirtyProjectIds.delete(projectId);
            
            renderAfterUpdate();
        }
        toast.style.display = 'none';
    };
}

async function checkAndRecoverData() {
    console.log("Verificando integridade dos dados e progresso...");
    const projectsCol = collection(db, "projects");
    try {
        const projectsSnap = await getDocs(query(projectsCol));
        if (!projectsSnap.empty) {
            let recovered = [];
            let needsUpdate = false;
            
            if (state.projects.length <= 1) {
                // 1. Recuperação em caso de desastre (lista local vazia/corrompida)
                console.warn("Recuperando dados da arquitetura fragmentada vazia...");
                projectsSnap.forEach(d => {
                    const data = d.data();
                    if (data.id && data.id !== 'p_default' && data.id !== 'v2_global_state') {
                        if (data.progressPct === undefined) {
                            data.progressPct = getProjectProgress(data);
                        }
                        recovered.push(data);
                    }
                });
                
                const defaultProj = state.projects.find(p => p.id === 'p_default') || state.projects[0];
                state.projects = [defaultProj, ...recovered];
                saveState();
                renderAfterUpdate();
                console.log("Recuperação por desastre concluída.");
            } else {
                // 2. Sincronizar progressPct APENAS de projetos que pertencem à lista ativa
                projectsSnap.forEach(d => {
                    const data = d.data();
                    if (data.id && data.id !== 'p_default' && data.id !== 'v2_global_state') {
                        const localProj = state.projects.find(p => p.id === data.id);
                        if (localProj && localProj.progressPct === undefined) {
                            localProj.progressPct = getProjectProgress(data);
                            needsUpdate = true;
                        }
                    }
                });
                
                if (needsUpdate) {
                    console.log("Sincronizando percentuais de progresso dos projetos ativos...");
                    saveState();
                    renderAfterUpdate();
                    console.log("Sincronização de progresso concluída.");
                }
            }
        }
    } catch (e) {
        console.warn("Aviso de recuperação:", e);
    }
}

function calculateProjectStats(project) {
    let pendente = 0;
    let apontamento = 0;
    const items = project.items || [];
    if (!project || !items) return { pendente: 0, apontamento: 0 };

    items.forEach(item => {
        const hasChildren = items.some(child => child.parentId === item.id);
        if (item.parentId !== null && !hasChildren) {
            if (!item.isNotApplicable && (!item.attachments || item.attachments.length === 0)) {
                pendente++;
            }
            if (item.validationStatus === 'Apontamento') {
                apontamento++;
            }
        }
    });

    return { pendente, apontamento };
}

async function exportProjectZipBlob(curr) {
    if (!curr || curr.id === 'none') {
        throw new Error('Selecione um empreendimento primeiro.');
    }
    if (typeof JSZip === 'undefined') {
        throw new Error('Biblioteca de compressão (JSZip) não carregada. Verifique sua conexão.');
    }

    const items = curr.items || [];
    const zip = new JSZip();
    const safeProjectName = curr.name.replace(/[\/\\?%*:|"<>]/g, '-');
    const rootFolder = zip.folder(safeProjectName);

    async function processItem(item, parentFolder) {
        const children = items.filter(i => i.parentId === item.id);
        const attachments = item.attachments || [];
        const hasDocs = attachments.length > 0;
        const isFolder = children.length > 0;

        if (!isFolder && !hasDocs) return;

        const safeName = item.name.replace(/[\/\\?%*:|"<>]/g, '-');
        const currentFolder = parentFolder.folder(safeName);

        if (hasDocs) {
            await Promise.all(attachments.map(async (att) => {
                try {
                    let url = null;
                    if (att.storagePath) {
                        try {
                            const storageRef = ref(storage, att.storagePath);
                            url = await getDownloadURL(storageRef);
                        } catch (urlErr) {
                            console.warn(`Erro Storage para ${att.name}:`, urlErr);
                        }
                    }
                    if (!url) url = att.downloadUrl || att.objectUrl || att.dropboxUrl;
                    
                    if (url) {
                        const response = await fetch(url);
                        if (response.ok) {
                            const blob = await response.blob();
                            const safeFileName = att.name.replace(/[\/\\?%*:|"<>]/g, '-');
                            currentFolder.file(safeFileName, blob);
                        }
                    }
                } catch (e) {
                    console.error(`Erro ao processar anexo "${att.name}":`, e);
                }
            }));
        }

        await Promise.all(children.map(child => processItem(child, currentFolder)));
    }

    const roots = items.filter(i => i.parentId === null);
    if (roots.length === 0) {
        throw new Error('Estrutura de pastas não encontrada para exportação.');
    }

    await Promise.all(roots.map(root => processItem(root, rootFolder)));

    console.log("Gerando arquivo ZIP final...");
    const content = await zip.generateAsync({ type: 'blob' });
    
    const zipUrl = URL.createObjectURL(content);
    const link = document.body.appendChild(document.createElement('a'));
    link.href = zipUrl;
    link.download = `${safeProjectName}_Documentacao.zip`;
    link.click();
    
    setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(zipUrl);
    }, 1000);
}

async function handleExportProjectZip(triggerBtn) {
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
            const originalBtnContent = triggerBtn.innerHTML;
            triggerBtn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Gerando ZIP...';
            triggerBtn.disabled = true;

            try {
                await exportProjectZipBlob(curr);
                showTemporaryMessage("Download iniciado com sucesso!");
            } catch (error) {
                console.error('Erro crítico na exportação ZIP:', error);
                alert(error.message || 'Ocorreu um erro ao gerar o arquivo ZIP. Verifique o console para detalhes.');
            } finally {
                triggerBtn.innerHTML = originalBtnContent;
                triggerBtn.disabled = false;
            }
        }
    });
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
let btnNewProject, btnExportZip, btnExportZipMgmt, btnExportPoints, btnToggleEng, btnDeleteProject, btnRenameProject, btnOpenTemplate, btnAddRoot;
let checklistContainer, sidebarApf, btnToggleSidebar, managementContainer, trackingContainer, dueDateContainer;
let tabs, tabContents, btnUnlock, btnBackToMain, inputPassword, passwordError, passwordLock, managementContent;
let btnSettings, btnSaveSettings, btnResetModel, geminiModelInp, geminiKeyInp, btnToggleKey, apfPassInp;
let btnTogglePendencias, pendenciasMgmtPanel, btnAddPendencia, pendenciaStartDateInp, modalOverlay, btnCloseModal;
let engAnalysisMgmtPanel, engAnalysisStartDateInp;
let btnShowHistory, historyModal, btnCloseHistory;
let projectDueDateInp, projectGlobalCountdown, headerLocationInfo;
let globalLogin, loginSector;
let btnLogout, topAuthInfo, authNavTabs, btnLoginThemeToggle;
let sidebarBackdrop;
let btnForgotPassword, forgotPasswordModal, btnCloseForgot;
let newProjectModal, btnCloseNewProject, btnConfirmNewProject, newProjNameInp, newProjUfInp, newProjCityInp, newProjDueDateInp, newProjIsOleInp;
let newProjectModalTitle, btnConfirmNewProjectText, newProjectModalInfo;
let editingProjectId = null;
let uploadToast, uploadToastText, uploadToastSub, uploadToastIcon;
let confirmModal, confirmModalTitle, confirmModalMessage, confirmModalIconContainer, btnConfirmYes, btnConfirmNo;
let headerMgmtActions, headerActionsSegment, apfChecklistControls;

function initDOMElements() {
    // Auth
    globalLogin = document.getElementById('global-login');
    loginSector = document.getElementById('login-sector');
    topAuthInfo = document.getElementById('top-auth-info');
    authNavTabs = document.getElementById('auth-nav-tabs');
    headerMgmtActions = document.getElementById('header-mgmt-actions');
    btnLoginThemeToggle = document.getElementById('btn-login-theme-toggle');
    btnLogout = document.getElementById('btn-logout');
    btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    sidebarBackdrop = document.getElementById('sidebar-backdrop');
    btnForgotPassword = document.getElementById('btn-forgot-password');
    forgotPasswordModal = document.getElementById('forgot-password-modal');
    btnCloseForgot = document.getElementById('btn-close-forgot');

    // Buttons
    btnNewProject = document.getElementById('btn-new-project');
    btnExportZip = document.getElementById('btn-export-zip');
    btnExportZipMgmt = document.getElementById('btn-export-zip-mgmt');
    btnExportPoints = document.getElementById('btn-export-points');
    btnToggleEng = document.getElementById('btn-toggle-eng');
    btnDeleteProject = document.getElementById('btn-delete-project');
    btnRenameProject = document.getElementById('btn-rename-project');
    headerActionsSegment = document.getElementById('header-actions-segment');
    btnOpenTemplate = document.getElementById('btn-open-template');
    btnAddRoot = document.getElementById('btn-add-root');
    apfChecklistControls = document.getElementById('apf-checklist-controls');
    btnSettings = document.getElementById('btn-settings');

    // Containers
    checklistContainer = document.getElementById('checklist-render-area');
    sidebarApf = document.getElementById('sidebar-apf');
    btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    managementContainer = document.getElementById('management-render-area');
    trackingContainer = document.getElementById('tracking-render-area');
    dueDateContainer = document.getElementById('due-date-container');
    headerLocationInfo = document.getElementById('header-location-info');

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

    // Análise CAIXA
    engAnalysisMgmtPanel = document.getElementById('eng-analysis-mgmt-panel');
    engAnalysisStartDateInp = document.getElementById('eng-analysis-start-date');

    // Inputs
    projectDueDateInp = document.getElementById('project-due-date');

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
    newProjDueDateInp = document.getElementById('new-proj-due-date');
    newProjIsOleInp = document.getElementById('new-proj-is-ole');
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

    // Global optimized elements
    globalFileInput = document.getElementById('global-file-input');
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
    updateHistorySidebarVisibility();
    renderProjectHistory();

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

    if (btnToggleSidebar) {
        btnToggleSidebar.addEventListener('click', toggleSidebar);
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

            if (password === correctPassword) {
                isAuthenticated = true;
                authenticatedSector = sector;
                inputPassword.value = '';
                passwordError.style.display = 'none';

                // Resetar seleção ao fazer login para exigir escolha manual (Conforme solicitado)
                localUI.currentProjectId = null;
                saveLocalUI();

                // Salvar sessão temporária no sessionStorage
                sessionStorage.setItem('apf_session_sector', sector);

                applyAuthState(true);
                renderAfterUpdate();
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
                    updateFirebaseStorageUI();
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
        forgotPasswordModal.onclick = (e) => { if (e.target === forgotPasswordModal) forgotPasswordModal.classList.add('hidden'); };
    }

    // Sidebar & Project Management Listeners
    if (btnExportPoints) {
        btnExportPoints.onclick = () => {
            generateProjectReport('only_points');
        };
    }

    if (projectDueDateInp) {
        projectDueDateInp.addEventListener('change', (e) => {
            const curr = getCurrentProject();
            if (curr && curr.id !== 'p_default') {
                curr.dueDate = e.target.value;
                addAuditLog('Prazo Geral Alterado', `O prazo geral do empreendimento foi alterado para <strong>${e.target.value}</strong>.`, 'warning');
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
        newProjectModal.onclick = (e) => { if (e.target === newProjectModal) newProjectModal.classList.add('hidden'); };
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
                if (newProjDueDateInp) newProjDueDateInp.value = '';
                if (newProjIsOleInp) newProjIsOleInp.checked = false;
                newProjectModal.classList.remove('hidden');
                if (newProjNameInp) newProjNameInp.focus();
            }
        });
    }

    // Controle do Dropdown de Novo Empreendimento / Modelo de Checklist
    const btnNewProjectDropdown = document.getElementById('btn-new-project-dropdown');
    const newProjectMenu = document.getElementById('new-project-menu');

    if (btnNewProjectDropdown && newProjectMenu) {
        btnNewProjectDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            newProjectMenu.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!btnNewProjectDropdown.contains(e.target) && !newProjectMenu.contains(e.target)) {
                newProjectMenu.classList.add('hidden');
            }
        });

        if (btnNewProject) {
            btnNewProject.addEventListener('click', () => {
                newProjectMenu.classList.add('hidden');
            });
        }
        if (btnOpenTemplate) {
            btnOpenTemplate.addEventListener('click', () => {
                newProjectMenu.classList.add('hidden');
            });
        }
    }

    if (btnConfirmNewProject) {
        btnConfirmNewProject.addEventListener('click', () => {
            const name = newProjNameInp.value.trim();
            const uf = newProjUfInp.value;
            const city = newProjCityInp.value.trim();
            const dueDate = newProjDueDateInp.value;
            const isOle = newProjIsOleInp ? newProjIsOleInp.checked : false;

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
                    proj.dueDate = dueDate;
                    proj.isOle = isOle;
                    addAuditLog('Empreendimento Editado', `Os dados do empreendimento <strong>${name}</strong> foram atualizados.`, 'info');
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
                    dueDate: dueDate,
                    engAnalysisOpened: false,
                    createdAt: new Date().toISOString().split('T')[0],
                    pendenciaActive: false,
                    pendencias: [],
                    isOle: isOle,
                    items: duplicatedItems
                };

                state.projects.push(newProj);
                localUI.currentProjectId = newProj.id;
                localUI.expandedIds.clear();
                addAuditLog('Empreendimento Criado', `O empreendimento <strong>${name}</strong> foi criado com sucesso.`, 'success');
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
        btnExportZip.addEventListener('click', () => handleExportProjectZip(btnExportZip));
    }
    if (btnExportZipMgmt) {
        btnExportZipMgmt.addEventListener('click', () => handleExportProjectZip(btnExportZipMgmt));
    }

    if (btnExportPoints) {
        btnExportPoints.onclick = () => {
            generateProjectReport('only_points');
        };
    }

    if (btnToggleEng) {
        btnToggleEng.addEventListener('click', () => {
            const curr = getCurrentProject();
            if (curr && curr.id !== 'p_default') {
                curr.engAnalysisOpened = !curr.engAnalysisOpened;

                if (curr.engAnalysisOpened) {
                    if (!curr.engAnalysisStartDate) {
                        curr.engAnalysisStartDate = new Date().toISOString().split('T')[0];
                    }
                } else {
                    curr.engAnalysisStartDate = '';
                }

                const actType = curr.engAnalysisOpened ? 'Abertura de Engenharia' : 'Fechamento de Engenharia';
                const actDesc = curr.engAnalysisOpened ? 'Análise de engenharia foi aberta para este empreendimento.' : 'Análise de engenharia foi fechada para este empreendimento.';
                addAuditLog(actType, actDesc, curr.engAnalysisOpened ? 'success' : 'warning');

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
                message: `Tem certeza que deseja excluir permanentemente o empreendimento "${curr.name}" e todos os seus documentos anexos?`,
                type: 'danger',
                confirmText: 'SIM, E EXPORTAR ARQUIVOS',
                cancelText: 'NÃO, CANCELAR',
                onConfirm: async () => {
                    const projectIdToDelete = localUI.currentProjectId;
                    const projName = curr.name;

                    // 1. Exportar ZIP antes de deletar
                    try {
                        showTemporaryMessage("Gerando ZIP de segurança...");
                        await exportProjectZipBlob(curr);
                        showTemporaryMessage("ZIP baixado com sucesso!");
                    } catch (zipErr) {
                        console.error("Erro ao exportar ZIP durante exclusão:", zipErr);
                    }

                    // 2. Excluir fisicamente todos os arquivos de anexos do Firebase Storage
                    const attachmentsToDelete = [];
                    const items = curr.items || [];
                    items.forEach(item => {
                        const attachments = item.attachments || [];
                        attachments.forEach(att => {
                            if (att.storagePath) {
                                attachmentsToDelete.push(att);
                            }
                        });
                    });

                    const pends = curr.pendencias || [];
                    pends.forEach(p => {
                        const attachments = p.attachments || [];
                        attachments.forEach(att => {
                            if (att.storagePath) {
                                attachmentsToDelete.push(att);
                            }
                        });
                    });

                    // Deletar assincronamente todos os anexos no Storage
                    await Promise.all(attachmentsToDelete.map(async (att) => {
                        try {
                            const storageRef = ref(storage, att.storagePath);
                            await deleteObject(storageRef);
                            console.log(`Arquivo do Storage ${att.name} excluído com sucesso.`);
                        } catch (err) {
                            console.error(`Erro ao deletar arquivo do Storage ${att.name}:`, err);
                        }
                    }));

                    // 3. Atualizar Estado Local
                    addAuditLog('Empreendimento Excluído', `O empreendimento <strong>${projName}</strong> foi excluído permanentemente com exportação de arquivos.`, 'danger');
                    const nextProj = state.projects.find(p => p.id !== projectIdToDelete) || state.projects[0];
                    state.projects = state.projects.filter(p => p.id !== projectIdToDelete);
                    localUI.currentProjectId = nextProj.id;
                    saveLocalUI();
                    saveState();

                    // 4. Excluir fisicamente o documento individual no Firestore
                    try {
                        const docRef = doc(db, `projects/${projectIdToDelete}`);
                        await deleteDoc(docRef);
                        console.log(`Documento individual ${projectIdToDelete} excluído fisicamente.`);
                    } catch (e) {
                        console.error("Erro ao deletar documento individual:", e);
                    }

                    updateGlobalDateUI();
                    renderTree();
                    renderTracking();
                    showTemporaryMessage(`Empreendimento removido com sucesso.`);
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
                if (newProjIsOleInp) newProjIsOleInp.checked = !!curr.isOle;
                if (newProjectModalInfo) newProjectModalInfo.style.display = 'none';

                if (newProjNameInp) newProjNameInp.value = curr.name || '';
                if (newProjUfInp) newProjUfInp.value = curr.uf || '';
                if (newProjCityInp) newProjCityInp.value = curr.cidade || '';
                if (newProjDueDateInp) newProjDueDateInp.value = curr.dueDate || '';

                newProjectModal.classList.remove('hidden');
                if (newProjNameInp) newProjNameInp.focus();
            }
        });
    }

    if (btnOpenTemplate) {
        btnOpenTemplate.onclick = () => {
            selectProject('p_default');
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
        if (!p) return;
        const items = p.items || [];

        const isExpanding = btn.querySelector('.label').textContent.includes('Mostrar');

        items.forEach(item => {
            const hasChildren = items.some(child => child.parentId === item.id);
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
            const actType = curr.pendenciaActive ? 'Resolução de Pendências Iniciada' : 'Resolução de Pendências Encerrada';
            const actDesc = curr.pendenciaActive ? 'Modo de resolução de pendências CAIXA foi ativado.' : 'Modo de resolução de pendências CAIXA foi desativado.';
            addAuditLog(actType, actDesc, curr.pendenciaActive ? 'warning' : 'success');
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
                        const oldName = pend.docName;
                        pend.docName = name;
                        pend.sector = sector;
                        pend.specification = specification;
                        addAuditLog('Pendência Editada', `A pendência <strong>${oldName}</strong> foi atualizada para <strong>${name}</strong> do setor <strong>${sector}</strong>.`, 'warning');
                    }
                    editingPendenciaId = null;
                    btnAddPendencia.innerHTML = '<i class="ph ph-plus"></i> Adicionar';
                    btnAddPendencia.classList.remove('btn-warning');
                    btnAddPendencia.classList.add('btn-danger');
                } else {
                    curr.pendencias.push({
                        id: generateId(), docName: name, sector: sector, specification: specification, attachments: [], observation: ''
                    });
                    addAuditLog('Pendência Criada', `Nova pendência <strong>${name}</strong> adicionada para o setor <strong>${sector}</strong>.`, 'warning');
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
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.add('hidden'); });
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

    // Global file input handler (Optimized)
    if (globalFileInput) {
        globalFileInput.onchange = (e) => {
            if (activeUploadItemId && e.target.files.length > 0) {
                window.handleFileUpload(activeUploadItemId, e.target.files, isUploadPendencia);
            }
        };
    }
}

function toggleSidebar() {
    localUI.sidebarCollapsed = !localUI.sidebarCollapsed;
    saveLocalUI();
    applySidebarState();
}

function applySidebarState() {
    if (!sidebarApf) return;
    const appContainer = document.querySelector('.app-container');

    const topBarTitle = document.getElementById('top-bar-title-text');

    if (localUI.sidebarCollapsed) {
        sidebarApf.classList.add('collapsed');
        if (appContainer) appContainer.classList.add('expanded');
        if (btnToggleSidebar) btnToggleSidebar.classList.remove('active');
        if (topBarTitle) topBarTitle.style.display = 'none';
    } else {
        sidebarApf.classList.remove('collapsed');
        if (appContainer) appContainer.classList.remove('expanded');
        if (btnToggleSidebar) btnToggleSidebar.classList.add('active');
        if (topBarTitle) topBarTitle.style.display = '';
    }

    // Em mobile, também controlamos a classe mobile-active se necessário, 
    // mas a lógica de colapso desktop é prioritária agora.
    if (window.innerWidth <= 992) {
        if (!localUI.sidebarCollapsed) {
            sidebarApf.classList.add('mobile-active');
            if (sidebarBackdrop) sidebarBackdrop.classList.add('active');
        } else {
            sidebarApf.classList.remove('mobile-active');
            if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
        }
    }
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
    toast.style.border = '1px solid rgba(var(--primary-rgb), )';

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

    const rootSectors = new Set();

    // 1. Sempre incluir os setores do Modelo Padrão (Garante que nunca fique vazio)
    DEFAULT_ITEMS.filter(i => i.parentId === null).forEach(i => rootSectors.add(i.name));

    // 2. Incluir pastas raiz de todos os empreendimentos ativos
    if (state && state.projects) {
        state.projects.forEach(p => {
            const items = p.items || [];
            if (items && items.length > 0) {
                items.filter(i => i.parentId === null).forEach(i => rootSectors.add(i.name));
            }
        });
    }

    const sortedSectors = [...rootSectors].sort();
    const currentVal = loginSector.value;

    // Repopular
    loginSector.innerHTML = '<option value="">Selecione seu setor...</option><option value="APF">APF (Administrativo)</option><option value="Olé">Olé (Acesso Total Olé)</option>';

    sortedSectors.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        loginSector.appendChild(opt);
    });

    if (currentVal) loginSector.value = currentVal;
}


function applyAuthState(silentRedirect = false) {
    if (!globalLogin || !managementContent) return;

    const tabsNav = document.querySelector('.tabs');
    // Restore session if exists and not yet set
    if (!isAuthenticated) {
        const savedSector = sessionStorage.getItem('apf_session_sector');
        if (savedSector) {
            isAuthenticated = true;
            authenticatedSector = savedSector;
        }
    }

    // isMgmt deve ser verdadeiro APENAS se o setor autenticado for APF.
    // Usuários de outros setores nunca devem estar no modo de gestão/administração.
    const isMgmt = (authenticatedSector === 'APF');
    const apfSubmenu = document.getElementById('apf-submenu');
    const apfBtn = document.querySelector('.apf-access-btn');

    const mainLayout = document.querySelector('.main-layout');
    if (!isAuthenticated) {
        // Site Completely Locked
        if (globalLogin) globalLogin.classList.remove('hidden');
        if (globalLogin) globalLogin.style.display = 'flex'; // Mantemos flex para o layout interno, mas removemos hidden
        if (mainLayout) mainLayout.classList.add('hidden');
        populateLoginSectors();
        if (inputPassword) inputPassword.focus();
        return;
    } else {
        if (globalLogin) globalLogin.classList.add('hidden');
        if (mainLayout) mainLayout.classList.remove('hidden');
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

    if (isMgmt) {
        // Force Management tab
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));

        const mgmtTab = document.getElementById('tab-management');
        if (mgmtTab) {
            mgmtTab.classList.add('active');
            mgmtTab.style.display = '';
        }

        const mgmtBtn = document.querySelector('[data-tab="management"]');
        if (mgmtBtn) mgmtBtn.classList.add('active');
    } else {
        // Site Default (non-APF) is Checklist
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));

        const checklistTab = document.getElementById('tab-checklist');
        if (checklistTab) {
            checklistTab.classList.add('active');
            checklistTab.style.display = '';
        }
    }

    if (headerMgmtActions) {
        headerMgmtActions.style.display = (authenticatedSector === 'APF') ? 'flex' : 'none';
    }

    if (headerActionsSegment) {
        headerActionsSegment.style.display = (authenticatedSector === 'APF') ? 'flex' : 'none';
    }

    if (apfChecklistControls) {
        apfChecklistControls.style.display = (authenticatedSector === 'APF') ? 'flex' : 'none';
    }

    if (projectDueDateInp) {
        projectDueDateInp.disabled = (authenticatedSector !== 'APF');
        projectDueDateInp.style.opacity = (authenticatedSector === 'APF') ? '1' : '0.5';
        projectDueDateInp.style.pointerEvents = (authenticatedSector === 'APF') ? 'auto' : 'none';
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

            // Hide Checklist tab button for APF
            if (authenticatedSector === 'APF' && btn.dataset.tab === 'checklist') {
                btn.style.display = 'none';
            } else {
                btn.style.display = 'flex';
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

    // Limpar estado visual de abas antes de sair
    if (tabs) tabs.forEach(t => t.classList.remove('active'));
    if (tabContents) tabContents.forEach(tc => tc.classList.remove('active'));

    // Garantir que nenhum elemento administrativo fique visível se o reload demorar
    if (headerMgmtActions) headerMgmtActions.style.display = 'none';
    if (headerActionsSegment) headerActionsSegment.style.display = 'none';
    if (apfChecklistControls) apfChecklistControls.style.display = 'none';

    // Return to login screen
    if (globalLogin) {
        globalLogin.classList.remove('hidden');
        globalLogin.style.display = 'flex';
    }
    if (authStatusBanner) authStatusBanner.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'none';

    const mainLayout = document.querySelector('.main-layout');
    if (mainLayout) mainLayout.classList.add('hidden');

    // Clear password input
    const inputPassword = document.getElementById('global-password-input');
    if (inputPassword) {
        inputPassword.value = '';
        inputPassword.focus();
    }

    applyAuthState(true);
    window.location.reload();
}




// Project Management & Global UI
function updateGlobalDateUI() {
    const p = getCurrentProject();
    const deck = document.getElementById('unified-header-deck');
    const dash = document.getElementById('unified-top-dashboard');
    const nameEl = document.getElementById('checklist-proj-name');
    const subtitleEl = document.getElementById('checklist-subtitle');
    const noProjPlaceholder = document.getElementById('no-project-selected');
    const mainWrapper = document.getElementById('main-content-wrapper');

    // 1. Estado Inicial: Nenhum projeto selecionado
    if (!p || p.id === 'none') {
        if (noProjPlaceholder) noProjPlaceholder.style.display = 'flex';
        if (mainWrapper) mainWrapper.style.display = 'none';
        if (deck) deck.style.display = 'none';
        if (nameEl) nameEl.textContent = 'APF Checklist';
        if (subtitleEl) subtitleEl.textContent = 'Selecione um empreendimento no painel lateral';
        return;
    }

    // Se houver projeto, mostrar o conteúdo principal
    if (noProjPlaceholder) noProjPlaceholder.style.display = 'none';
    if (mainWrapper) mainWrapper.style.display = 'block';
    if (deck) deck.style.display = 'flex';

    // 2. Caso Especial: MODELO DE ENTREGA
    if (p.id === 'p_default') {
        if (dash) dash.style.display = 'none';
        if (nameEl) nameEl.textContent = p.name;
        if (subtitleEl) {
            subtitleEl.innerHTML = '<i class="ph ph-layout" style="opacity: 0.7;"></i> Estrutura Base de Documentação';
            subtitleEl.className = 'default-subtitle';
        }
        if (btnRenameProject) btnRenameProject.style.display = 'none';
        if (btnDeleteProject) btnDeleteProject.style.display = 'none';
        if (dueDateContainer) dueDateContainer.style.display = 'none';
        if (projectGlobalCountdown) projectGlobalCountdown.style.display = 'none';

        // Reseta filtro no modelo
        treeSearchFilter = 'all';
        return;
    }

    // 3. Caso Normal: Empreendimentos Reais
    if (nameEl) nameEl.textContent = p.name;

    // Subtítulo Superior: Apenas Fase
    if (subtitleEl) {
        subtitleEl.innerHTML = `ENTREGA DE DOCUMENTAÇÃO`;
        subtitleEl.className = 'default-subtitle';
    }

    // Localização Abaixo do Nome
    const locationStr = (p.cidade || p.uf) ? `${p.cidade || 'Cidade'}${p.cidade && p.uf ? ' - ' : ''}${p.uf || 'UF'}` : '';
    if (headerLocationInfo) {
        if (locationStr) {
            headerLocationInfo.innerHTML = `<i class="ph ph-map-pin" style="opacity: 0.7;"></i> ${locationStr}`;
            headerLocationInfo.style.display = 'flex';
        } else {
            headerLocationInfo.style.display = 'none';
        }
    }


    const isAPF = authenticatedSector === 'APF';
    const headerActionsSegment = document.getElementById('header-actions-segment');
    if (headerActionsSegment) headerActionsSegment.style.display = isAPF ? 'flex' : 'none';

    // Controles acima do checklist (Novo Setor, Relatórios, etc)
    const apfChecklistControls = document.getElementById('apf-checklist-controls');
    if (apfChecklistControls) apfChecklistControls.style.display = isAPF ? 'flex' : 'none';

    if (btnRenameProject) btnRenameProject.style.display = isAPF ? 'inline-flex' : 'none';
    if (btnDeleteProject) btnDeleteProject.style.display = isAPF ? 'inline-flex' : 'none';
    if (btnAddRoot) btnAddRoot.style.display = isAPF ? 'inline-flex' : 'none';
    if (dueDateContainer) dueDateContainer.style.display = 'none';
    if (projectDueDateInp) { projectDueDateInp.disabled = !isAPF; projectDueDateInp.value = p.dueDate || ''; }

    // RENDERIZAR PAINEL UNIFICADO
    console.log('Rendering unified dashboard for:', p.name);
    updateProjectProgressUI(p);

    // Lógica Dinâmica de Contador no Cabeçalho (Relógio)
    if (projectGlobalCountdown) {
        let countdownHTML = '';
        let countdownColor = '';
        let showCountdown = false;

        if (p.pendenciaActive) {
            const start = p.pendenciaStartDate ? new Date(p.pendenciaStartDate) : new Date();
            start.setHours(0, 0, 0, 0);
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const diff = Math.floor((today - start) / (1000 * 60 * 60 * 24));
            countdownHTML = `<i class="ph ph-clock"></i> Em resolução a ${diff >= 0 ? diff : 0} dias`;
            countdownColor = 'var(--danger)';
            showCountdown = true;
        } else if (p.engAnalysisOpened) {
            const start = p.engAnalysisStartDate ? new Date(p.engAnalysisStartDate) : new Date();
            start.setHours(0, 0, 0, 0);
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const diff = Math.floor((today - start) / (1000 * 60 * 60 * 24));
            countdownHTML = `<i class="ph ph-clock"></i> Em análise a ${diff >= 0 ? diff : 0} dias`;
            countdownColor = 'var(--info)';
            showCountdown = true;
        } else if (p.dueDate) {
            const bizDays = calculateBusinessDays(p.dueDate);
            const diff = calculateDays(p.dueDate);
            const isExpired = new Date(p.dueDate) < new Date().setHours(0, 0, 0, 0);
            if (isExpired) {
                countdownHTML = `<i class="ph ph-warning-circle"></i> Atrasado ${Math.abs(diff)} dia(s)`;
                countdownColor = 'var(--danger)';
            } else {
                countdownHTML = `<i class="ph ph-clock"></i> ${bizDays} dias úteis restantes`;
                countdownColor = bizDays <= 5 ? 'var(--warning)' : 'var(--accent)';
            }
            showCountdown = true;
        }

        if (showCountdown) {
            projectGlobalCountdown.innerHTML = countdownHTML;
            projectGlobalCountdown.style.color = countdownColor;
            projectGlobalCountdown.style.display = 'block';
        } else {
            projectGlobalCountdown.style.display = 'none';
        }
    }

    // Análise CAIXA?
    const btnToggleEngId = 'btn-toggle-eng';
    const btnToggleEngEl = document.getElementById(btnToggleEngId);

    if (p.engAnalysisOpened) {
        let daysDisplay = 0;
        if (p.engAnalysisStartDate) {
            const start = new Date(p.engAnalysisStartDate);
            start.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const diff = Math.floor((today - start) / (1000 * 60 * 60 * 24));
            daysDisplay = diff >= 0 ? diff : 0;
        }

        const label = `Análise CAIXA │ ${daysDisplay} dias`;
        if (btnToggleEngEl) {
            btnToggleEngEl.innerHTML = `<i class="ph ph-calendar"></i> ${label}`;
            btnToggleEngEl.className = 'btn';
            btnToggleEngEl.style.backgroundColor = 'rgba(96, 165, 250, 0.1)';
            btnToggleEngEl.style.color = 'var(--info)';
            btnToggleEngEl.style.borderColor = 'var(--info)';
        }
        if (engAnalysisMgmtPanel) {
            engAnalysisMgmtPanel.classList.remove('hidden');
        }
        if (engAnalysisStartDateInp) {
            engAnalysisStartDateInp.value = p.engAnalysisStartDate || '';
        }
        // O contador global (relógio) agora é gerenciado dinamicamente no início da função
    } else {
        if (btnToggleEngEl) {
            btnToggleEngEl.innerHTML = '<i class="ph ph-calendar"></i> Abrir Engenharia';
            btnToggleEngEl.className = 'btn btn-outline';
            btnToggleEngEl.style.backgroundColor = '';
            btnToggleEngEl.style.color = '';
            btnToggleEngEl.style.borderColor = '';
        }
        if (engAnalysisMgmtPanel) {
            engAnalysisMgmtPanel.classList.add('hidden');
        }
    }

    renderProjectStagesStepper(p);
}

// Garante que o array de etapas dinâmicas esteja inicializado baseado no estado legado do projeto
function ensureCustomStages(p) {
    if (!p) return;
    if (!p.customStages || p.customStages.length === 0) {
        let activeStageNum = 1;
        if (p.pendenciaActive) activeStageNum = 3;
        else if (p.engAnalysisOpened) activeStageNum = 2;

        p.customStages = [
            {
                id: 'stage_1',
                type: 'doc_inicial',
                title: 'Documentação Inicial',
                status: activeStageNum === 1 ? 'active' : 'completed',
                startDate: ''
            },
            {
                id: 'stage_2',
                type: 'analise_caixa',
                title: 'Análise CAIXA',
                status: activeStageNum === 2 ? 'active' : (activeStageNum > 2 ? 'completed' : 'waiting'),
                startDate: p.engAnalysisStartDate || ''
            },
            {
                id: 'stage_3',
                type: 'pendencias',
                title: 'Resolução de Pendências',
                status: activeStageNum === 3 ? 'active' : 'waiting',
                startDate: p.pendenciaStartDate || ''
            }
        ];
    }
}

// Sincroniza campos legados baseando-se no estágio ativo atual do array customStages
function syncLegacyFields(p) {
    ensureCustomStages(p);
    const activeStage = p.customStages.find(s => s.status === 'active');
    if (!activeStage) {
        p.engAnalysisOpened = false;
        p.pendenciaActive = false;
        return;
    }

    if (activeStage.type === 'doc_inicial') {
        p.engAnalysisOpened = false;
        p.pendenciaActive = false;
    } else if (activeStage.type === 'analise_caixa') {
        p.engAnalysisOpened = true;
        p.pendenciaActive = false;
        p.engAnalysisStartDate = activeStage.startDate || '';
    } else if (activeStage.type === 'pendencias') {
        p.engAnalysisOpened = true;
        p.pendenciaActive = true;
        p.pendenciaStartDate = activeStage.startDate || '';
        
        // Recuperar última data de início da análise da engenharia para compatibilidade
        const lastEng = [...p.customStages].reverse().find(s => s.type === 'analise_caixa');
        if (lastEng) {
            p.engAnalysisStartDate = lastEng.startDate || '';
        }
    }
}

// Stepper de Estágios do Empreendimento
function renderProjectStagesStepper(p) {
    const stepperContainer = document.getElementById('project-stages-stepper');
    if (!stepperContainer) return;

    if (!p || p.id === 'none' || p.id === 'p_default') {
        stepperContainer.style.display = 'none';
        return;
    }

    ensureCustomStages(p);
    stepperContainer.className = 'stages-stepper';
    stepperContainer.classList.add(`stages-count-${p.customStages.length}`);
    stepperContainer.style.display = 'flex';

    syncLegacyFields(p);

    const isAPF = authenticatedSector === 'APF';

    let html = '';
    p.customStages.forEach((s, idx) => {
        // Calcular dias em cada fase para descrição
        let daysCount = 0;
        if (s.startDate) {
            const start = new Date(s.startDate);
            start.setHours(0, 0, 0, 0);
            
            let end = new Date();
            if (s.status === 'completed' && idx < p.customStages.length - 1) {
                const nextStage = p.customStages[idx + 1];
                if (nextStage && nextStage.startDate) {
                    end = new Date(nextStage.startDate);
                }
            }
            end.setHours(0, 0, 0, 0);
            const diff = Math.floor((end - start) / (1000 * 60 * 60 * 24));
            daysCount = diff >= 0 ? diff : 0;
        }

        let desc = 'Aguardando início';
        let icon = 'ph ph-calendar';
        let color = 'var(--text-muted)';
        let colorRgb = '161, 161, 170';

        if (s.type === 'doc_inicial') {
            desc = s.status === 'active' ? 'Em envio / validação' : 'Concluído';
            icon = 'ph ph-file-arrow-up';
            color = s.status === 'active' ? 'var(--text-muted)' : 'var(--accent)';
            colorRgb = s.status === 'active' ? '161, 161, 170' : '16, 185, 129';
        } else if (s.type === 'analise_caixa') {
            if (s.status === 'active') {
                desc = s.startDate ? `Em análise a ${daysCount} dias` : 'Em análise CAIXA';
                icon = 'ph ph-spinner ph-spin';
                color = 'var(--info)';
                colorRgb = '96, 165, 250';
            } else if (s.status === 'completed') {
                desc = s.startDate ? `Análise de ${daysCount} dias concluída` : 'Concluído';
                icon = 'ph ph-calendar';
                color = 'var(--accent)';
                colorRgb = '16, 185, 129';
            } else {
                desc = 'Aguardando envio';
                icon = 'ph ph-calendar';
            }
        } else if (s.type === 'pendencias') {
            if (s.status === 'active') {
                desc = s.startDate ? `Em correção a ${daysCount} dias` : 'Em correção';
                icon = 'ph ph-warning-diamond';
                color = 'var(--danger)';
                colorRgb = '239, 68, 68';
            } else if (s.status === 'completed') {
                desc = s.startDate ? `Correções de ${daysCount} dias concluídas` : 'Concluído';
                icon = 'ph ph-warning-diamond';
                color = 'var(--accent)';
                colorRgb = '16, 185, 129';
            } else {
                desc = 'Aguardando retorno';
                icon = 'ph ph-warning-diamond';
            }
        }

        let stateClass = '';
        if (s.status === 'active') {
            stateClass = 'active';
        } else if (s.status === 'completed') {
            stateClass = 'completed';
        }

        const isClickable = isAPF;
        const clickableClass = isClickable ? 'clickable-step' : '';

        // Estilos customizados de variáveis CSS para o estado ativo
        const styleVars = `style="--step-color: ${color}; --step-color-rgb: ${colorRgb};"`;

        let dateInputHTML = '';
        if (isAPF && s.status === 'active') {
            if (s.type === 'analise_caixa') {
                dateInputHTML = `
                    <div class="step-date-wrapper" onclick="event.stopPropagation()">
                        <label class="step-date-label">Data de Abertura Real</label>
                        <input type="date" class="step-date-input custom-stage-date-input" data-stage-id="${s.id}" value="${s.startDate || ''}">
                    </div>
                `;
            } else if (s.type === 'pendencias') {
                dateInputHTML = `
                    <div class="step-date-wrapper" onclick="event.stopPropagation()">
                        <label class="step-date-label">Data de Início</label>
                        <input type="date" class="step-date-input custom-stage-date-input" data-stage-id="${s.id}" value="${s.startDate || ''}">
                    </div>
                `;
            }
        }

        html += `
            <div class="step-item ${stateClass} ${clickableClass}" ${styleVars} onclick="handleStageTransition('${s.id}')">
                ${isAPF && idx > 2 ? `
                    <button class="step-delete-btn" onclick="event.stopPropagation(); handleDeleteCustomStage('${s.id}')" title="Excluir esta etapa">
                        <i class="ph ph-x"></i>
                    </button>
                ` : ''}
                <div class="step-icon-circle">
                    <i class="${s.status === 'completed' ? 'ph ph-check-circle' : icon}"></i>
                </div>
                <div class="step-content">
                    <span class="step-title">${s.title}</span>
                    <span class="step-desc">${desc}</span>
                    ${dateInputHTML}
                </div>
            </div>
        `;

        // Linha conectora entre etapas
        if (idx < p.customStages.length - 1) {
            const lineActiveClass = s.status === 'completed' ? 'active' : '';
            html += `<div class="step-line ${lineActiveClass}"></div>`;
        }
    });

    // Se o usuário logado for APF, exibe o botão "+" de adicionar etapa customizada
    if (isAPF) {
        html += `
            <div class="add-step-wrapper" onclick="event.stopPropagation()">
                <button class="add-step-btn" id="btn-add-stepper-stage" title="Adicionar Nova Etapa">
                    <i class="ph ph-plus"></i>
                </button>
                <div class="add-step-dropdown hidden" id="add-stepper-stage-dropdown">
                    <button onclick="handleAddCustomStage('analise_caixa')">
                        <i class="ph ph-calendar"></i> Inserir Análise CAIXA
                    </button>
                    <button onclick="handleAddCustomStage('pendencias')">
                        <i class="ph ph-warning-diamond"></i> Inserir Resolução de Pendências
                    </button>
                </div>
            </div>
        `;
    }

    stepperContainer.innerHTML = html;

    // Configurar listeners de data dinâmicos
    const dateInputs = stepperContainer.querySelectorAll('.custom-stage-date-input');
    dateInputs.forEach(inp => {
        inp.onchange = (e) => {
            const stageId = e.target.getAttribute('data-stage-id');
            const targetStageObj = p.customStages.find(s => s.id === stageId);
            if (targetStageObj) {
                targetStageObj.startDate = e.target.value;
                syncLegacyFields(p);

                let actionName = targetStageObj.type === 'analise_caixa' ? 'Data de Engenharia Alterada' : 'Data de Pendências Alterada';
                let actionDesc = targetStageObj.type === 'analise_caixa' 
                    ? `A data de início da análise de engenharia (${targetStageObj.title}) foi alterada para <strong>${e.target.value}</strong>.`
                    : `A data de início da resolução de pendências (${targetStageObj.title}) foi alterada para <strong>${e.target.value}</strong>.`;

                addAuditLog(actionName, actionDesc, 'info');
                saveState();
                updateGlobalDateUI();
                renderTracking();
            }
        };
    });

    // Configurar clique para abrir/fechar o dropdown de adicionar etapas
    const addBtn = document.getElementById('btn-add-stepper-stage');
    const dropdown = document.getElementById('add-stepper-stage-dropdown');
    if (addBtn && dropdown) {
        addBtn.onclick = (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('hidden');
        };
    }
}

// Handler para transição de estágios
window.handleStageTransition = function(targetStageId) {
    const isAPF = authenticatedSector === 'APF';
    if (!isAPF) return; // Apenas APF pode interagir

    const p = getCurrentProject();
    if (!p || p.id === 'none' || p.id === 'p_default') return;

    ensureCustomStages(p);
    const activeStage = p.customStages.find(s => s.status === 'active');
    if (activeStage && activeStage.id === targetStageId) return;

    const targetIndex = p.customStages.findIndex(s => s.id === targetStageId);
    if (targetIndex === -1) return;

    const targetStage = p.customStages[targetIndex];

    showConfirm({
        title: 'Mudar Estágio do Empreendimento',
        message: `Confirmar transição para o estágio "<strong>${targetStage.title}</strong>"?`,
        type: 'info',
        confirmText: 'Confirmar',
        onConfirm: () => {
            p.customStages.forEach((s, idx) => {
                if (idx < targetIndex) {
                    s.status = 'completed';
                } else if (idx === targetIndex) {
                    s.status = 'active';
                } else {
                    s.status = 'waiting';
                }
            });

            syncLegacyFields(p);

            addAuditLog('Estágio Atualizado', `Estágio do empreendimento alterado para <strong>${targetStage.title}</strong>.`, 'success');
            saveState();
            updateGlobalDateUI();
            renderTracking();
        }
    });
};

// Handler para adicionar etapa customizada
window.handleAddCustomStage = function(type) {
    const p = getCurrentProject();
    if (!p || p.id === 'none' || p.id === 'p_default') return;

    ensureCustomStages(p);
    const newNum = p.customStages.length + 1;
    const stageTypeNames = {
        analise_caixa: 'Análise CAIXA',
        pendencias: 'Resolução de Pendências'
    };

    p.customStages.push({
        id: `stage_${newNum}_${Date.now()}`,
        type: type,
        title: `${stageTypeNames[type]} ${p.customStages.filter(s => s.type === type).length + 1}`,
        status: 'waiting',
        startDate: ''
    });

    addAuditLog('Etapa Adicionada', `Nova etapa de <strong>${stageTypeNames[type]}</strong> foi incluída no fluxo do empreendimento.`, 'info');
    saveState();
    renderProjectStagesStepper(p);
};

// Handler para remover etapa customizada
window.handleDeleteCustomStage = function(stageId) {
    const p = getCurrentProject();
    if (!p || p.id === 'none' || p.id === 'p_default') return;

    ensureCustomStages(p);
    const targetIndex = p.customStages.findIndex(s => s.id === stageId);
    if (targetIndex === -1) return;

    const targetStageObj = p.customStages[targetIndex];

    showConfirm({
        title: 'Remover Etapa Customizada',
        message: `Deseja remover a etapa "<strong>${targetStageObj.title}</strong>"?`,
        type: 'danger',
        confirmText: 'Remover',
        onConfirm: () => {
            if (targetStageObj.status === 'active') {
                const prevStage = p.customStages[targetIndex - 1];
                if (prevStage) {
                    prevStage.status = 'active';
                }
            }

            p.customStages = p.customStages.filter(s => s.id !== stageId);

            // Re-mapear títulos e números sequenciais das etapas customizadas restantes
            const counts = { analise_caixa: 1, pendencias: 1 };
            p.customStages.forEach((s, idx) => {
                if (idx > 2) {
                    const baseTitle = s.type === 'analise_caixa' ? 'Análise CAIXA' : 'Resolução de Pendências';
                    counts[s.type]++;
                    s.title = `${baseTitle} ${counts[s.type]}`;
                }
            });

            syncLegacyFields(p);

            addAuditLog('Etapa Removida', `A etapa <strong>${targetStageObj.title}</strong> foi removida do fluxo do empreendimento.`, 'danger');
            saveState();
            updateGlobalDateUI();
            renderTracking();
        }
    });
};

// Fechar o dropdown de adicionar etapas ao clicar fora dele
document.addEventListener('click', () => {
    const dropdown = document.getElementById('add-stepper-stage-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
});



// Global filter handler for dashboard cards
window.handleDashboardFilter = function (filter, count) {
    // Permitir desativar o filtro atual mesmo que o count seja 0
    if (count === 0 && filter !== 'all' && treeSearchFilter !== filter) {
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
        // Auto-expand ao aplicar filtro para mostrar os resultados encontrados
        expandRelevantNodes();
    }

    saveLocalUI();
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
    const headerDeck = document.getElementById('unified-header-deck');
    const mgmtArea = document.getElementById('management-render-area');

    const animClass = 'animate-smooth-entry';

    // Usamos um pequeno timeout para garantir que o navegador processe as mudanças de display: block
    // antes de tentar iniciar a animação, garantindo que o efeito seja visível.
    setTimeout(() => {
        if (headerDeck) {
            headerDeck.classList.remove(animClass);
            void headerDeck.offsetWidth;
            headerDeck.classList.add(animClass);
        }

        // Animamos o layout completo do checklist (incluindo painéis laterais)
        const checkLayout = document.querySelector('.checklist-analysis-layout');
        if (checkLayout) {
            checkLayout.classList.remove(animClass);
            void checkLayout.offsetWidth;
            checkLayout.classList.add(animClass);
        }

        if (mgmtArea) {
            mgmtArea.classList.remove(animClass);
            void mgmtArea.offsetWidth;
            mgmtArea.classList.add(animClass);
        }
    }, 10);
}

// Tracker Render
function renderTracking() {
    if (!trackingContainer) return;
    trackingContainer.innerHTML = '';

    // ALWAYS filter out the template from the sidebar as per user request
    let trackableProjects = state.projects.filter(p => p.id !== 'p_default');

    // FILTRAGEM OLÉ:
    const isAPF = authenticatedSector === 'APF';
    const isOleUser = authenticatedSector === 'Olé';

    if (isAPF) {
        // APF vê tudo
    } else if (isOleUser) {
        // Login Olé vê apenas empreendimentos Olé
        trackableProjects = trackableProjects.filter(p => p.isOle === true);
    } else {
        // Outros setores vêem apenas empreendimentos NÃO Olé
        trackableProjects = trackableProjects.filter(p => p.isOle !== true);
    }

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

    if (trackableProjects.length === 0) {
        if (isInitialCloudLoad) {
            trackingContainer.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);"><i class="ph ph-spinner ph-spin" style="font-size:1.5rem; margin-bottom:0.5rem; display:block;"></i> Sincronizando empreendimentos...</div>';
        } else {
            trackingContainer.innerHTML = '<p style="color:var(--text-muted); padding: 1rem; border: 1px dashed var(--divider-color); border-radius:0.5rem;"><i class="ph ph-warning"></i> Nenhum empreendimento ativo criado ainda. Primeiramente, crie no Acesso APF.</p>';
        }
        return;
    }

    trackableProjects.forEach((p, i) => {
        const card = document.createElement('div');
        const isActive = p.id === localUI.currentProjectId ? 'active' : '';
        card.className = `tracking-card glass-panel ${isActive}`;

        // Inicializar e identificar estágio ativo no customStages
        ensureCustomStages(p);
        const activeStage = p.customStages.find(s => s.status === 'active') || p.customStages[0];

        let badgeText = activeStage.title;
        let badgeClass = 'badge-doc';
        let indicatorColor = 'var(--text-muted)';

        let daysDisplay = 0;
        if (activeStage.startDate) {
            const start = new Date(activeStage.startDate);
            start.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const diff = Math.floor((today - start) / (1000 * 60 * 60 * 24));
            daysDisplay = diff >= 0 ? diff : 0;
        }

        if (activeStage.type === 'analise_caixa') {
            badgeText = `${daysDisplay}d`;
            badgeClass = 'badge-info-transl';
            indicatorColor = 'var(--info)';
        } else if (activeStage.type === 'pendencias') {
            badgeText = `${daysDisplay}d`;
            badgeClass = 'badge-danger-transl';
            indicatorColor = 'var(--danger)';
        } else {
            badgeText = '';
        }

        card.style.setProperty('--indicator-color', indicatorColor);

        card.addEventListener('click', () => {
            selectProject(p.id);
        });

        const progressPct = p.progressPct !== undefined ? p.progressPct : getProjectProgress(p);
        const isCaixaAnalysis = activeStage && activeStage.type === 'analise_caixa';

        // Prazo / Vencimento no rodapé (Apenas exibido se estiver no estágio de Documentação Inicial)
        let footerInfoHTML = '';
        if (activeStage.type === 'doc_inicial') {
            if (p.dueDate) {
                const diff = calculateDays(p.dueDate);
                let prazoDesc = '';
                let pColorClass = 'good';
                if (diff === 0) {
                    prazoDesc = 'Hoje';
                    pColorClass = 'warning';
                } else if (diff > 0) {
                    prazoDesc = `${diff}d`;
                    pColorClass = 'good';
                } else {
                    prazoDesc = `${Math.abs(diff)}d atrasado`;
                    pColorClass = 'danger';
                }

                footerInfoHTML = `
                    <div class="card-footer-item ${pColorClass}">
                        <i class="ph ph-calendar-blank"></i>
                        <span>${formatDateToPT(p.dueDate)} (${prazoDesc})</span>
                    </div>
                `;
            } else {
                footerInfoHTML = `
                    <div class="card-footer-item muted">
                        <i class="ph ph-calendar-blank"></i>
                        <span>Sem prazo</span>
                    </div>
                `;
            }
        }

        card.innerHTML = `
            <div class="card-left-section">
                ${badgeText ? `<span class="card-status-badge ${badgeClass}">${badgeText}</span>` : ''}
            </div>
            <div class="tracking-body">
                <div class="card-top-row">
                    <h3 class="card-project-title" title="${p.name}">
                        <i class="ph ph-buildings"></i>${p.name}
                    </h3>
                </div>

                <div class="card-mid-row">
                    ${(p.cidade || p.uf) ? `
                    <div class="card-location">
                        <i class="ph ph-map-pin"></i> 
                        <span>${p.cidade || ''}${p.cidade && p.uf ? ' - ' : ''}${p.uf || ''}</span>
                    </div>` : ''}
                    ${footerInfoHTML}
                </div>

                ${!isCaixaAnalysis ? `
                <div class="card-progress-row">
                    <div class="card-progress-bar-container">
                        <div class="card-progress-bar" style="width: ${progressPct}%; background: ${progressPct === 100 ? 'var(--accent)' : 'var(--primary)'};"></div>
                    </div>
                    <span class="card-progress-text">${progressPct}%</span>
                </div>` : ''}
            </div>
        `;
        trackingContainer.appendChild(card);
    });

    renderAnalysisPanels();
}


// Rendering Tree Helpers
function getProjectProgress(p) {
    if (!p) return 0;

    // Se estiver em pendência ativa, o cálculo é baseado na lista de pendências críticas
    if (p.pendenciaActive) {
        const pendencias = p.pendencias || [];
        if (pendencias.length === 0) return 0;
        const resolved = pendencias.filter(item => item.attachments && item.attachments.length > 0 && item.validationStatus !== 'Apontamento').length;
        return Math.round((resolved / pendencias.length) * 100);
    }

    // Caso contrário, usa o cálculo padrão de itens do checklist
    if (!p.items) return 0;
    const items = p.items;
    const leafItems = items.filter(i => {
        const hasChildren = items.some(child => child.parentId === i.id);
        return i.parentId !== null && !hasChildren && !i.isNotApplicable;
    });

    if (leafItems.length === 0) return 0;
    const deliveredCount = leafItems.filter(i => i.attachments && i.attachments.length > 0 && i.validationStatus !== 'Apontamento').length;
    return Math.round((deliveredCount / leafItems.length) * 100);
}

function getItemSortPriority(item) {
    const allItems = getItems();
    // Se for uma pasta (ou seja, possui filhos no checklist), tem prioridade 0 (fica no topo)
    const isFolder = allItems.some(child => child.parentId === item.id);
    if (isFolder) {
        return 0;
    }

    // Se for marcado como "Não Obrigatório", vai para o final absoluto (Prioridade 4)
    if (item.isNotApplicable) {
        return 4;
    }

    const hasAtt = item.attachments && item.attachments.length > 0;
    const status = (item.validationStatus || '').trim().toLowerCase();

    // Grupo 1: Pendente (sem anexo) ou com Apontamento
    if (!hasAtt || status === 'apontamento') {
        return 1;
    }
    // Grupo 2: Em Análise
    if (hasAtt && status !== 'validado' && status !== 'apf check' && status !== 'apontamento') {
        return 2;
    }
    // Grupo 3: Validado
    if (status === 'validado' || status === 'apf check') {
        return 3;
    }

    return 1; // Fallback
}

function getChildItems(parentId) {
    return getItems()
        .filter(item => item.parentId === parentId)
        .sort((a, b) => {
            const prioA = getItemSortPriority(a);
            const prioB = getItemSortPriority(b);

            if (prioA !== prioB) {
                return prioA - prioB;
            }

            // Desempate: ordem alfabética por nome
            return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
        });
}

function getNodeStats(itemId) {
    const p = getCurrentProject();
    if (!p) return { pendente: 0, apontamento: 0, total: 0, validated: 0 };

    let pendente = 0;
    let apontamento = 0;
    let total = 0;
    let validated = 0;

    const children = getChildItems(itemId);
    const item = (p.items || []).find(i => i.id === itemId);

    if (item && item.parentId !== null && children.length === 0) {
        if (!item.isNotApplicable) {
            total++;
            const hasAtt = item.attachments && item.attachments.length > 0;
            if (!hasAtt) {
                pendente++;
            } else {
                const status = (item.validationStatus || '').trim().toLowerCase();
                if (status === 'validado' || status === 'apf check') {
                    validated++;
                } else if (status === 'apontamento') {
                    apontamento++;
                }
            }
        }
    }

    children.forEach(child => {
        const childStats = getNodeStats(child.id);
        pendente += childStats.pendente;
        apontamento += childStats.apontamento;
        total += childStats.total;
        validated += childStats.validated;
    });

    return { pendente, apontamento, total, validated };
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

    // Header para as Pendências
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '0.5rem';
    header.style.marginBottom = '1.2rem';
    header.style.color = 'var(--danger)';
    header.innerHTML = '<i class="ph ph-warning-diamond" style="font-size: 1.5rem;"></i> <strong style="font-size: 1.1rem; text-transform: uppercase; letter-spacing: 0.05em;">PENDÊNCIAS CAIXA (Agrupadas por Setor)</strong>';
    wrapper.appendChild(header);

    const isAPF = authenticatedSector === 'APF';

    // Agrupar pendências por setor
    const pendenciasPorSetor = {};
    curr.pendencias.forEach(p => {
        const sectorName = p.sector || 'Geral';
        if (!pendenciasPorSetor[sectorName]) {
            pendenciasPorSetor[sectorName] = [];
        }
        pendenciasPorSetor[sectorName].push(p);
    });

    // Ordenar setores alfabeticamente
    const sortedSectors = Object.keys(pendenciasPorSetor).sort();

    if (!localUI.expandedPendenciasSectors) {
        localUI.expandedPendenciasSectors = new Set();
    }

    sortedSectors.forEach(sectorName => {
        const pendenciasDoSetor = pendenciasPorSetor[sectorName];
        const isExpanded = localUI.expandedPendenciasSectors.has(sectorName);

        const sectorNode = document.createElement('div');
        sectorNode.className = `tree-node ${isExpanded ? '' : 'collapsed'}`;

        const sectorItem = document.createElement('div');
        sectorItem.className = 'tree-item';
        sectorItem.style.cursor = 'pointer';

        // Lado Esquerdo do item de setor (Chevron + Ícone + Nome do Setor)
        const itemLeft = document.createElement('div');
        itemLeft.className = 'item-left';

        const chevron = document.createElement('i');
        chevron.className = 'ph ph-caret-down';
        chevron.style.marginRight = '0.5rem';

        const icon = document.createElement('i');
        let iconClass = 'ph-folder';
        const n = sectorName.toLowerCase();
        if (n.includes('legaliza')) iconClass = 'ph-scales';
        else if (n.includes('arquit') || n.includes('urbani')) iconClass = 'ph-compass-tool';
        else if (n.includes('engenh')) iconClass = 'ph-wrench';
        else if (n.includes('sustent')) iconClass = 'ph-leaf';
        icon.className = `ph ${iconClass} item-icon`;

        // Estatísticas do setor de pendências
        const total = pendenciasDoSetor.length;
        const entregues = pendenciasDoSetor.filter(p => p.attachments && p.attachments.length > 0).length;
        const validadas = pendenciasDoSetor.filter(p => p.attachments && p.attachments.length > 0 && (p.validationStatus === 'Validado' || p.validationStatus === 'APF check')).length;
        const apontamentos = pendenciasDoSetor.filter(p => p.validationStatus === 'Apontamento').length;

        // Definir cor do ícone de pasta do setor com base no status das pendências
        let iconColor = 'rgba(239, 68, 68, 0.85)'; // Pendente por padrão
        if (total === validadas) {
            iconColor = 'rgba(16, 185, 129, 0.85)'; // Todas validadas
        } else if (total === entregues) {
            iconColor = 'rgba(245, 158, 11, 0.85)'; // Todas entregues, mas pendentes de validação
        } else if (apontamentos > 0) {
            iconColor = 'rgba(239, 68, 68, 0.85)'; // Há apontamentos
        }
        icon.style.color = iconColor;

        const nameWrapper = document.createElement('div');
        nameWrapper.className = 'name-wrapper';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'item-name text-truncate root-name';
        nameSpan.style.display = 'flex';
        nameSpan.style.alignItems = 'center';
        nameSpan.style.gap = '0.5rem';
        nameSpan.style.fontSize = '1.05rem';
        nameSpan.style.fontWeight = '700';

        nameSpan.appendChild(chevron);
        nameSpan.appendChild(icon);

        const titleText = document.createTextNode(' ' + sectorName);
        nameSpan.appendChild(titleText);

        nameWrapper.appendChild(nameSpan);
        itemLeft.appendChild(nameWrapper);

        // Lado Direito do item de setor (Contadores de progresso e indicador de pendência)
        const itemRight = document.createElement('div');
        itemRight.className = 'item-right';

        // Badge de progresso (ex: "1/3 Entregues")
        const progBadge = document.createElement('span');
        progBadge.className = entregues === total ? 'badge badge-validado badge-sm' : 'badge badge-analise badge-sm';
        progBadge.textContent = `${entregues}/${total} Entregues`;
        itemRight.appendChild(progBadge);

        // Se houver apontamentos, exibir badge de apontamento
        if (apontamentos > 0) {
            const apBadge = document.createElement('span');
            apBadge.className = 'badge badge-apontamento badge-sm';
            apBadge.textContent = `${apontamentos} Apontamento(s)`;
            itemRight.appendChild(apBadge);
        }

        // Se houver pendências críticas não entregues, exibir contador vermelho
        const naoEntregues = total - entregues;
        if (naoEntregues > 0) {
            const pendCircle = document.createElement('span');
            pendCircle.className = 'pending-circle';
            pendCircle.textContent = naoEntregues;
            pendCircle.title = `${naoEntregues} pendências sem entrega`;
            itemRight.appendChild(pendCircle);
        }

        // Lock icon se o usuário logado não for deste setor nem APF/Olé
        const isLocked = authenticatedSector && authenticatedSector !== 'APF' && authenticatedSector !== 'Olé' && authenticatedSector.trim().toLowerCase() !== sectorName.trim().toLowerCase();
        if (isLocked) {
            const lockIcon = document.createElement('i');
            lockIcon.className = 'ph ph-lock-simple';
            lockIcon.style.color = 'var(--text-muted)';
            lockIcon.style.opacity = '0.6';
            lockIcon.style.fontSize = '1.1rem';
            lockIcon.title = 'Acesso Restrito';
            itemRight.appendChild(lockIcon);
        }

        sectorItem.appendChild(itemLeft);
        sectorItem.appendChild(itemRight);

        // Clique no setor para alternar expansão
        sectorItem.onclick = () => {
            if (localUI.expandedPendenciasSectors.has(sectorName)) {
                localUI.expandedPendenciasSectors.delete(sectorName);
            } else {
                localUI.expandedPendenciasSectors.add(sectorName);
            }
            saveLocalUI();
            renderTree();
        };

        sectorNode.appendChild(sectorItem);

        // Container de filhos para as pendências
        const childCont = document.createElement('div');
        childCont.className = 'children-container';

        // Renderizar cada pendência do setor
        pendenciasDoSetor.forEach(p => {
            const canEditPend = isAPF || (authenticatedSector || '').trim().toLowerCase() === (p.sector || '').trim().toLowerCase();
            const pNodeWrapper = document.createElement('div');
            pNodeWrapper.className = 'tree-node pendencia-node';

            const node = document.createElement('div');
            node.className = 'tree-item pendencia-item';
            
            // Ajustar o visual dos itens filhos (borda colorida conforme o status)
            let borderCol = 'rgba(239, 68, 68, 0.4)';
            const hasAtt = p.attachments && p.attachments.length > 0;
            if (hasAtt) {
                if (p.validationStatus === 'Validado' || p.validationStatus === 'APF check') {
                    borderCol = 'rgba(16, 185, 129, 0.4)';
                } else if (p.validationStatus === 'Apontamento') {
                    borderCol = 'rgba(239, 68, 68, 0.4)';
                } else {
                    borderCol = 'rgba(245, 158, 11, 0.4)'; // Em análise
                }
            }
            node.style.borderLeft = `2px solid ${borderCol}`;

            const itemLeft = document.createElement('div');
            itemLeft.className = 'item-left';

            // Ícone de status do arquivo da pendência
            const pIcon = document.createElement('i');
            pIcon.className = hasAtt ? 'ph ph-file-text item-icon' : 'ph ph-file-warning item-icon';
            
            // Cor do ícone da pendência
            let pIconColor = 'rgba(239, 68, 68, 0.85)';
            if (hasAtt) {
                if (p.validationStatus === 'Validado' || p.validationStatus === 'APF check') {
                    pIconColor = 'rgba(16, 185, 129, 0.85)';
                } else if (p.validationStatus === 'Apontamento') {
                    pIconColor = 'rgba(239, 68, 68, 0.85)';
                } else {
                    pIconColor = 'rgba(245, 158, 11, 0.85)';
                }
            }
            pIcon.style.color = pIconColor;

            itemLeft.appendChild(pIcon);

            const pNameWrapper = document.createElement('div');
            pNameWrapper.style.display = 'flex';
            pNameWrapper.style.flexDirection = 'column';

            const pNameSpan = document.createElement('span');
            pNameSpan.className = 'item-name';
            pNameSpan.style.fontWeight = '700';
            pNameSpan.style.color = 'var(--text-main)';
            pNameSpan.textContent = p.docName;

            pNameWrapper.appendChild(pNameSpan);

            if (p.specification) {
                const pSpec = document.createElement('div');
                pSpec.style.marginTop = '0.25rem';
                pSpec.style.fontSize = '0.75rem';
                pSpec.style.color = 'var(--primary)';
                pSpec.style.display = 'flex';
                pSpec.style.alignItems = 'flex-start';
                pSpec.style.gap = '0.3rem';
                pSpec.style.flexWrap = 'wrap';
                pSpec.style.lineHeight = '1.4';
                pSpec.innerHTML = `<i class="ph ph-chat-centered-dots" style="margin-top: 0.15rem;"></i> <strong style="flex-shrink: 0;">Especificação:</strong> <span style="flex: 1; min-width: 200px; white-space: normal; word-break: break-word;">${p.specification}</span>`;
                pNameWrapper.appendChild(pSpec);
            }

            itemLeft.appendChild(pNameWrapper);

            const itemRight = document.createElement('div');
            itemRight.className = 'item-right';

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
            if (hasAtt && p.validationStatus) {
                const valBadge = document.createElement('span');
                if (p.validationStatus === 'APF check' || p.validationStatus === 'Validado') {
                    valBadge.className = 'badge badge-validado badge-sm';
                    valBadge.textContent = 'Validado';
                }
                else if (p.validationStatus === 'Apontamento') {
                    valBadge.className = 'badge badge-apontamento badge-sm';
                    valBadge.textContent = p.validationStatus;
                }
                else {
                    valBadge.className = 'badge badge-analise badge-sm';
                    valBadge.textContent = p.validationStatus;
                }
                statusRow.appendChild(valBadge);
            }

            // Attach Button
            if (canEditPend) {
                const btnAttach = document.createElement('button');
                btnAttach.className = 'icon-btn attach-icon-btn';
                btnAttach.title = 'Anexar documento de pendência';
                btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
                btnAttach.onclick = (e) => {
                    e.stopPropagation();
                    activeUploadItemId = p.id;
                    isUploadPendencia = true;
                    if (globalFileInput) globalFileInput.click();
                };
                statusRow.appendChild(btnAttach);
            }

            itemRight.appendChild(statusRow);

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

            if (canEditPend) {
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
            } else {
                obsInput.disabled = true;
                obsInput.placeholder = 'Apenas o setor responsável pode adicionar observações.';
                obsInput.value = p.observation || '';
            }

            obsBox.appendChild(obsInput);
            if (p.observation && p.observation.trim() !== '') {
                btnObs.style.borderColor = 'var(--accent)';
                btnObs.style.color = 'var(--accent)';
            }
            btnObs.onclick = () => obsBox.classList.toggle('open');

            itemRight.appendChild(btnObs);
            itemRight.appendChild(obsBox);

            node.appendChild(itemLeft);
            node.appendChild(itemRight);

            // Anexos da pendência
            if (hasAtt) {
                const attContainer = document.createElement('div');
                attContainer.className = 'node-attachments-container';
                p.attachments.forEach(att => {
                    const badge = createAttachmentBadge(att, p.id, canEditPend, false, true);
                    attContainer.appendChild(badge);
                });
                node.appendChild(attContainer);
            }

            pNodeWrapper.appendChild(node);
            childCont.appendChild(pNodeWrapper);
        });

        sectorNode.appendChild(childCont);
        wrapper.appendChild(sectorNode);
    });

    checklistContainer.appendChild(wrapper);
}

function updateProjectProgressUI(curr) {
    const container = document.getElementById('unified-top-dashboard');
    if (!container) {
        console.warn('Dashboard container not found!');
        return;
    }

    if (!curr || curr.id === 'p_default' || curr.id === 'none') {
        container.style.display = 'none';
        return;
    }

    console.log('Updating Dashboard for:', curr.name);
    container.style.display = 'flex';

    const isAPF = authenticatedSector === 'APF';

    const items = curr.items || [];
    const leafItems = items.filter(i => {
        const hasChildren = items.some(child => child.parentId === i.id);
        return i.parentId !== null && !hasChildren && !i.isNotApplicable;
    });

    // --- CÁLCULOS DE ESTATÍSTICAS (FILTROS) ---
    const isPendenciaMode = curr.pendenciaActive;
    let allStatsItems = isPendenciaMode ? (curr.pendencias || []) : leafItems;

    // --- CÁLCULOS DE PROGRESSO ---
    let generalProgressPct = 0;
    if (allStatsItems.length > 0) {
        const deliveredCount = allStatsItems.filter(i => i.attachments && i.attachments.length > 0 && i.validationStatus !== 'Apontamento').length;
        generalProgressPct = Math.round((deliveredCount / allStatsItems.length) * 100);
    }

    let filteredStatsItems = allStatsItems;
    if (!isAPF) {
        const userSectorNormalized = (authenticatedSector || '').trim().toLowerCase();
        if (isPendenciaMode) {
            filteredStatsItems = allStatsItems.filter(i => (i.sector || '').trim().toLowerCase() === userSectorNormalized);
        } else {
            filteredStatsItems = allStatsItems.filter(i => (getItemSector(i.id) || '').trim().toLowerCase() === userSectorNormalized);
        }
    }

    const total = filteredStatsItems.length;
    const validated = filteredStatsItems.filter(i => ((i.validationStatus === 'Validado' || i.validationStatus === 'APF check') && i.attachments?.length > 0) || i.isNotApplicable).length;
    const withPoints = filteredStatsItems.filter(i => i.validationStatus === 'Apontamento' && i.attachments?.length > 0).length;
    const pending = filteredStatsItems.filter(i => !i.attachments || i.attachments.length === 0 && !i.isNotApplicable).length;
    const inAnalysis = total - validated - withPoints - pending;

    // --- RENDERIZAÇÃO SEÇÃO DE ANÁLISE (GRID 2x2 para APF) ---
    let analysisSectionHTML = '';

    if (isAPF) {
        // Encontra todos os setores (pastas raiz)
        const sectors = items.filter(i => i.parentId === null).sort((a, b) => a.name.localeCompare(b.name));

        analysisSectionHTML = `
            <!-- DIVISOR VERTICAL -->
            <div class="divider-v" style="height: 60px; background: var(--divider-color);"></div>
            
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; flex-grow: 1; max-width: 480px;">
        `;

        sectors.forEach(s => {
            const sectorLeafs = allStatsItems.filter(i => {
                const iSector = isPendenciaMode ? i.sector : getItemSector(i.id);
                return (iSector || '').trim().toLowerCase() === s.name.trim().toLowerCase();
            });
            let sPct = 0;
            if (sectorLeafs.length > 0) {
                const sDelivered = sectorLeafs.filter(i => i.attachments && i.attachments.length > 0 && i.validationStatus !== 'Apontamento').length;
                sPct = Math.round((sDelivered / sectorLeafs.length) * 100);
            }
            const grade = getGrade(sPct);

            analysisSectionHTML += `
                <div class="adaptive-card" style="display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.6rem;">
                    <div style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: ${grade.bg}; border-radius: 50%; font-size: 0.8rem; font-weight: 900; color: ${grade.color}; box-shadow: inset 0 0 8px ${grade.color}22;">
                        ${grade.g}
                    </div>
                    <div style="display: flex; flex-direction: column; overflow: hidden;">
                        <span style="font-size: 0.55rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${s.name}</span>
                        <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-main);">${sPct}%</span>
                    </div>
                </div>
            `;
        });

        analysisSectionHTML += `</div>`;
    } else {
        // VIEW SETOR: Única nota (Comportamento Original)
        const sectorLeafItems = allStatsItems.filter(i => {
            const iSector = isPendenciaMode ? i.sector : getItemSector(i.id);
            return (iSector || '').trim().toLowerCase() === (authenticatedSector || '').trim().toLowerCase();
        });
        if (sectorLeafItems.length > 0) {
            const validatedSectorCount = sectorLeafItems.filter(i => (i.validationStatus === 'Validado' || i.validationStatus === 'APF check') && i.attachments?.length > 0).length;
            const sectorAnalysisPct = Math.round((validatedSectorCount / sectorLeafItems.length) * 100);
            const sectorGrade = getGrade(sectorAnalysisPct);

            analysisSectionHTML = `
                <div class="divider-v" style="height: 48px; background: var(--divider-color);"></div>
                <div style="display: flex; align-items: center; gap: 1rem; min-width: 180px;">
                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 54px; height: 54px; background: ${sectorGrade?.bg || 'var(--card-bg-subtle)'}; border-radius: 50%; border: 1px solid ${sectorGrade?.color || 'var(--divider-color)'};">
                        <span style="font-size: 1.25rem; font-weight: 900; color: ${sectorGrade?.color || 'var(--text-muted)'}; line-height: 1;">${sectorGrade?.g || '-'}</span>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 0rem;">
                        <div style="color: var(--info); font-size: 0.55rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: -2px;">Análise do setor</div>
                        <span style="font-size: 1.05rem; font-weight: 800; color: var(--text-main);">${sectorGrade?.label || 'Em análise...'}</span>
                    </div>
                </div>
            `;
        }
    }

    // --- ESTILO DOS CARTÕES ---
    const cardStyle = `background: var(--dashboard-card-bg, rgba(255, 255, 255, 0.06)); border: 1px solid var(--divider-color); border-radius: 16px; padding: 1.25rem; box-shadow: 0 4px 20px rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 1rem;`;
    const cardTitleStyle = `font-size: 0.75rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.25rem;`;

    // --- CARTÃO 1: PROGRESSO GLOBAL ---
    let progressSectionHTML = '';
    if (isAPF) {
        progressSectionHTML = `
            <div style="${cardStyle} flex: 0 0 auto; min-width: auto; align-items: center;">
                <div style="${cardTitleStyle} text-align: center;">Progresso Global</div>
                <div style="display: flex; align-items: center; justify-content: center; margin-top: auto; margin-bottom: auto; padding: 0.5rem;">
                    <div class="circular-progress-container" style="width: 80px; height: 80px;">
                        <div class="circular-progress" style="--progress: ${generalProgressPct}%; background: conic-gradient(var(--accent) var(--progress), var(--progress-track) 0);"></div>
                        <span class="progress-text" style="font-size: 1.4rem; font-weight: 800; color: var(--text-main);">${generalProgressPct}%</span>
                    </div>
                </div>
            </div>
        `;
    } else {
        const sectorLeafItems = allStatsItems.filter(i => {
            const iSector = isPendenciaMode ? i.sector : getItemSector(i.id);
            return (iSector || '').trim().toLowerCase() === (authenticatedSector || '').trim().toLowerCase();
        });
        let sPct = 0;
        if (sectorLeafItems.length > 0) {
            const deliveredSectorCount = sectorLeafItems.filter(i => i.attachments && i.attachments.length > 0 && i.validationStatus !== 'Apontamento').length;
            sPct = Math.round((deliveredSectorCount / sectorLeafItems.length) * 100);
        }
        progressSectionHTML = `
            <div style="${cardStyle} flex: 0 0 auto; min-width: auto;">
                <div style="${cardTitleStyle} text-align: center;">Progresso do Seu Setor</div>
                <div style="display: flex; align-items: center; justify-content: center; gap: 2rem; margin-top: auto; margin-bottom: auto;">
                    <div style="display: flex; align-items: center; gap: 1.25rem;">
                        <div class="circular-progress-container" style="width: 64px; height: 64px;">
                            <div class="circular-progress" style="--progress: ${sPct}%; background: conic-gradient(var(--accent) var(--progress), var(--progress-track) 0);"></div>
                            <span class="progress-text" style="font-size: 1rem; font-weight: 800; color: var(--text-main);">${sPct}%</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.8rem; opacity: 0.8; border-left: 1px solid var(--divider-color); padding-left: 1.5rem;">
                        <div class="circular-progress-container" style="width: 44px; height: 44px;">
                            <div class="circular-progress" style="--progress: ${generalProgressPct}%; background: conic-gradient(var(--text-muted) var(--progress), var(--progress-track) 0);"></div>
                            <span class="progress-text" style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted);">${generalProgressPct}%</span>
                        </div>
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">Global</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // --- CARTÃO 2: RESUMO DE DOCUMENTOS ---
    const totalDocs = validated + inAnalysis + pending + withPoints;
    
    // Pequena barra de progresso empilhada
    const valPct = totalDocs ? (validated / totalDocs) * 100 : 0;
    const anaPct = totalDocs ? (inAnalysis / totalDocs) * 100 : 0;
    const pendPct = totalDocs ? (pending / totalDocs) * 100 : 0;
    const revPct = totalDocs ? (withPoints / totalDocs) * 100 : 0;

    const stackedBar = `
        <div style="display: flex; width: 100%; height: 6px; border-radius: 3px; overflow: hidden; background: var(--card-bg-subtle); margin-bottom: 0.5rem; opacity: 0.8;">
            <div style="width: ${valPct}%; background: rgba(16, 185, 129, 0.85);" title="Validados"></div>
            <div style="width: ${anaPct}%; background: rgba(245, 158, 11, 0.85);" title="Em Análise"></div>
            <div style="width: ${pendPct}%; background: rgba(239, 68, 68, 0.6);" title="Pendentes"></div>
            <div style="width: ${revPct}%; background: rgba(239, 68, 68, 0.95);" title="Revisar"></div>
        </div>
    `;

    const summarySectionHTML = `
        <div style="${cardStyle}">
            <div style="${cardTitleStyle}">Resumo de Documentos</div>
            ${stackedBar}
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem;">
                <div class="dashboard-card accent adaptive-card ${treeSearchFilter === 'validado' ? 'active' : ''}" onclick="handleDashboardFilter('validado', ${validated})" style="padding: 0.5rem; border-radius: 12px; display: flex; align-items: center; gap: 0.5rem;">
                    <div style="background: rgba(16, 185, 129, 0.15); color: rgba(16, 185, 129, 0.9); border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i class="ph ph-check-circle" style="font-size: 1.2rem;"></i></div>
                    <div style="display: flex; flex-direction: column;">
                        <span class="card-value" style="font-size: 1rem; line-height: 1;">${validated}</span>
                        <span class="card-label" style="font-size: 0.6rem; text-transform: uppercase; margin-top: 2px;">Validados</span>
                    </div>
                </div>
                <div class="dashboard-card warning adaptive-card ${treeSearchFilter === 'analise' ? 'active' : ''}" onclick="handleDashboardFilter('analise', ${inAnalysis})" style="padding: 0.5rem; border-radius: 12px; display: flex; align-items: center; gap: 0.5rem;">
                    <div style="background: rgba(245, 158, 11, 0.15); color: rgba(245, 158, 11, 0.9); border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i class="ph ph-clock" style="font-size: 1.2rem;"></i></div>
                    <div style="display: flex; flex-direction: column;">
                        <span class="card-value" style="font-size: 1rem; line-height: 1;">${inAnalysis}</span>
                        <span class="card-label" style="font-size: 0.6rem; text-transform: uppercase; margin-top: 2px;">Análise</span>
                    </div>
                </div>
                <div class="dashboard-card danger adaptive-card ${treeSearchFilter === 'pendente' ? 'active' : ''}" onclick="handleDashboardFilter('pendente', ${pending})" style="padding: 0.5rem; border-radius: 12px; display: flex; align-items: center; gap: 0.5rem;">
                    <div style="background: rgba(239, 68, 68, 0.1); color: rgba(239, 68, 68, 0.7); border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i class="ph ph-file-dashed" style="font-size: 1.2rem;"></i></div>
                    <div style="display: flex; flex-direction: column;">
                        <span class="card-value" style="font-size: 1rem; line-height: 1;">${pending}</span>
                        <span class="card-label" style="font-size: 0.6rem; text-transform: uppercase; margin-top: 2px;">Pendentes</span>
                    </div>
                </div>
                <div class="dashboard-card danger adaptive-card ${treeSearchFilter === 'apontamento' ? 'active' : ''}" onclick="handleDashboardFilter('apontamento', ${withPoints})" style="padding: 0.5rem; border-radius: 12px; display: flex; align-items: center; gap: 0.5rem;">
                    <div style="background: rgba(239, 68, 68, 0.2); color: rgba(239, 68, 68, 0.95); border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;"><i class="ph ph-warning-octagon" style="font-size: 1.2rem;"></i></div>
                    <div style="display: flex; flex-direction: column;">
                        <span class="card-value" style="font-size: 1rem; line-height: 1;">${withPoints}</span>
                        <span class="card-label" style="font-size: 0.6rem; text-transform: uppercase; margin-top: 2px;">Revisar</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    // --- CARTÃO 3: DESEMPENHO POR SETOR ---
    let analysisCardHTML = '';
    if (isAPF) {
        analysisCardHTML = `
            <div style="${cardStyle}">
                <div style="${cardTitleStyle}">Desempenho por Setor</div>
                <div style="margin-top: -0.5rem;">
                    ${analysisSectionHTML}
                </div>
            </div>
        `;
    } else {
        analysisCardHTML = `
            <div style="${cardStyle}">
                <div style="${cardTitleStyle}">Desempenho do Setor</div>
                <div style="margin-top: auto; margin-bottom: auto;">
                    ${analysisSectionHTML}
                </div>
            </div>
        `;
    }

    // Ajustar o estilo do container principal para o layout em cartões
    container.style.gap = '1.5rem';
    container.style.alignItems = 'stretch';

    container.innerHTML = `
        ${progressSectionHTML}
        ${summarySectionHTML}
        ${analysisCardHTML}
    `;

}


function calculateDays(dueDate) {
    if (!dueDate) return null;
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
                const cIsFolder = items.some(i => i.parentId === c.id) || c.parentId === null;
                const cValidOrAPF = c.validationStatus === 'APF check' || c.validationStatus === 'Validado';
                const cPointed = c.validationStatus === 'Apontamento';

                let cMatchesFilter = true;
                const cSector = getItemSector(c.id);
                const userSector = (authenticatedSector || '').trim().toLowerCase();
                const itemSectorNormalized = (cSector || '').trim().toLowerCase();
                const sectorMatches = authenticatedSector === 'APF' || itemSectorNormalized === userSector;

                if (treeSearchFilter !== 'all') {
                    if (cIsFolder) {
                        cMatchesFilter = false;
                    } else if (!sectorMatches) {
                        cMatchesFilter = false;
                    } else {
                        if (treeSearchFilter === 'pendente') cMatchesFilter = !cHasAtt && !c.isNotApplicable;
                        else if (treeSearchFilter === 'apontamento') cMatchesFilter = cHasAtt && cPointed;
                        else if (treeSearchFilter === 'validado') cMatchesFilter = (cHasAtt && cValidOrAPF) || c.isNotApplicable;
                        else if (treeSearchFilter === 'analise') cMatchesFilter = cHasAtt && !cValidOrAPF && !cPointed;
                    }
                }

                return (cMatches && cMatchesFilter && sectorMatches) || anyChildMatches(c.id);
            });
        };

        if (anyChildMatches(item.id)) {
            localUI.expandedIds.add(item.id);
        }
    });
    saveLocalUI();
}

function formatDateToPT(isoStr) {
    if (!isoStr) return '';
    const parts = isoStr.split('-');
    if (parts.length !== 3) return isoStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function renderTree() {
    const p = getCurrentProject();
    if (!p) return;

    // Update Toggle All Button Text
    const btnChecklist = document.getElementById('btn-toggle-all-checklist');
    const btnMgmt = document.getElementById('btn-toggle-all-mgmt');

    // Check if at least one folder is expanded (Safe check for .items)
    const items = p.items || [];
    const foldersWithChildren = items.filter(item => items.some(child => child.parentId === item.id));
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

    if (!checklistContainer || !managementContainer) return;

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
        if (state.projects.length <= 1) msg = '<i class="ph ph-warning"></i> Você precisa criar um Empreendimento novo na aba "Acesso APF" para manipular os checklists.';
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
    if (rootItems.length === 0 && currProj.id !== 'p_default' && currProj.id !== 'none') {
        const loadingHtml = `
            <div style="text-align:center; padding:4rem 1rem; color:var(--text-muted);">
                <i class="ph ph-spinner ph-spin" style="font-size:2rem; margin-bottom:1rem; display:block; margin-left:auto; margin-right:auto;"></i>
                Sincronizando documentos do empreendimento...
            </div>`;
        if (mgmt) managementContainer.innerHTML = loadingHtml;
        else checklistContainer.innerHTML = loadingHtml;
        return;
    }

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

    updateProjectProgressUI(currProj);
    updateGlobalDateUI();
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

function createStatusButtonGroup(item, onStatusChange) {
    const group = document.createElement('div');
    group.className = 'status-btn-group';
    
    const options = [
        { label: 'Análise', value: 'Em Análise de APF', icon: 'ph-magnifying-glass', color: 'warning' },
        { label: 'Validar', value: 'APF check', icon: 'ph-check-circle', color: 'success' },
        { label: 'Apontar', value: 'Apontamento', icon: 'ph-warning-diamond', color: 'danger' }
    ];

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = `status-btn ${opt.color}`;
        const isActive = item.validationStatus === opt.value || (opt.value === 'APF check' && item.validationStatus === 'Validado');
        if (isActive) btn.classList.add('active');
        
        btn.innerHTML = `<i class="ph ${opt.icon}"></i> ${opt.label}`;
        btn.onclick = (e) => {
            if (e) e.stopPropagation();
            onStatusChange(opt.value);
        };
        group.appendChild(btn);
    });
    
    return group;
}

function createAttachmentBadge(att, itemId, canEdit, isMgmt = false, isPendencia = false) {
    const attBadge = document.createElement('div');
    attBadge.className = 'inline-attachment';
    
    const nameTxt = document.createElement('span');
    nameTxt.className = 'text-attachment-name';
    nameTxt.title = att.name;
    nameTxt.textContent = att.name;

    const url = att.downloadUrl || att.objectUrl;
    const btnView = document.createElement('a');
    btnView.href = url || '#';
    btnView.target = url ? '_blank' : '_self';
    btnView.className = 'icon-btn view-link';
    btnView.innerHTML = '<i class="ph ph-eye"></i>';
    btnView.style.cursor = url ? 'pointer' : 'not-allowed';
    btnView.onclick = (e) => {
        if (!url) {
            e.preventDefault();
            alert("URL do arquivo não disponível.");
        }
        e.stopPropagation();
    };

    attBadge.appendChild(nameTxt);



    if (att.aiCheckResult) {
        const aiStatusIcon = document.createElement('i');
        const resLower = (att.aiCheckResult || "").toLowerCase();
        const isSuccess = resLower.includes('sim') && !resLower.includes('não');
        aiStatusIcon.className = isSuccess ? 'ph ph-shield-check text-accent' : 'ph ph-shield-warning text-warning';
        aiStatusIcon.title = `[IA Check autom.]: ${att.aiCheckResult}`;
        attBadge.appendChild(aiStatusIcon);
    }

    attBadge.appendChild(btnView);

    const btnDel = document.createElement('button');
    btnDel.className = 'icon-btn delete';
    btnDel.innerHTML = '<i class="ph ph-x"></i>';
    btnDel.onclick = (e) => { e.stopPropagation(); window.handleDeleteFile(itemId, att.id, isPendencia); };
    
    if (!canEdit) {
        btnDel.style.display = 'none';
    }
    attBadge.appendChild(btnDel);

    return attBadge;
}


function createNode(item, level) {
    const children = getChildItems(item.id);
    const isRootFolder = item.parentId === null;
    const isMgmt = isMgmtActive();
    const currProj = getCurrentProject();

    // Per-sector permission logic
    const nodeSector = getItemSector(item.id);
    const isAPF = authenticatedSector === 'APF';
    const isOleUser = authenticatedSector === 'Olé';
    const isOleProject = !!currProj.isOle;

    let canEdit = isAPF || (authenticatedSector || '').trim().toLowerCase() === (nodeSector || '').trim().toLowerCase();

    // Login Olé tem acesso irrestrito em projetos Olé
    if (isOleUser && isOleProject) {
        canEdit = true;
    }

    // SEARCH & FILTER LOGIC
    if (treeSearchQuery || treeSearchFilter !== 'all') {
        const userSector = (authenticatedSector || '').trim().toLowerCase();

        const checkItemMatch = (targetItem) => {
            const hasAtt = targetItem.attachments && targetItem.attachments.length > 0;
            const itemValidOrAPF = targetItem.validationStatus === 'Validado' || targetItem.validationStatus === 'APF check';
            const itemPointed = targetItem.validationStatus === 'Apontamento';
            
            const targetSector = getItemSector(targetItem.id);
            const targetSectorNormalized = (targetSector || '').trim().toLowerCase();
            const sectorMatches = isAPF || targetSectorNormalized === userSector || (isOleUser && isOleProject);

            if (!sectorMatches) return false;

            if (treeSearchFilter === 'pendente') return !hasAtt && !targetItem.isNotApplicable;
            if (treeSearchFilter === 'apontamento') return hasAtt && itemPointed;
            if (treeSearchFilter === 'validado') return (hasAtt && itemValidOrAPF) || targetItem.isNotApplicable;
            if (treeSearchFilter === 'analise') return hasAtt && !itemValidOrAPF && !itemPointed;
            return true;
        };

        const matchesQuery = item.name.toLowerCase().includes(treeSearchQuery);
        let matchesFilter = checkItemMatch(item);
        
        // Pastas vazias não "casam" com filtros de status a menos que o filtro seja 'all'
        const isFolder = getItems().some(i => i.parentId === item.id) || item.parentId === null;
        if (treeSearchFilter !== 'all' && isFolder && !(item.attachments?.length > 0)) {
            matchesFilter = false;
        }

        // An item should be shown if it matches OR if any of its children match
        const anyChildMatches = (nodeId) => {
            const children = getItems().filter(i => i.parentId === nodeId);
            return children.some(c => {
                const cMatchesQuery = c.name.toLowerCase().includes(treeSearchQuery);
                const cMatchesFilter = checkItemMatch(c);
                const cIsFolder = getItems().some(i => i.parentId === c.id);
                
                let cFinalMatch = cMatchesQuery;
                if (treeSearchFilter !== 'all') {
                    cFinalMatch = cMatchesFilter && (cMatchesQuery || true); // O filtro de status é soberano se ativo
                    if (cIsFolder && !(c.attachments?.length > 0)) cFinalMatch = false;
                }

                return cFinalMatch || anyChildMatches(c.id);
            });
        };

        if (!(matchesQuery && (treeSearchFilter === 'all' || matchesFilter)) && !anyChildMatches(item.id)) {
            return null;
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
    if (isRootFolder) {
        let iconClass = 'ph-folder-notch-open';
        const n = item.name.toLowerCase();
        if (n.includes('legaliza')) iconClass = 'ph-scales';
        else if (n.includes('arquit') || n.includes('urbani')) iconClass = 'ph-compass-tool';
        else if (n.includes('engenh')) iconClass = 'ph-wrench';
        else if (n.includes('sustent')) iconClass = 'ph-leaf';
        icon.className = `ph ${iconClass} item-icon`;
    }
    else {
        if (hasChildren) {
            icon.className = 'ph ph-folder item-icon';
        } else {
            icon.className = (item.attachments && item.attachments.length > 0) ? 'ph ph-file-text item-icon' : 'ph ph-file item-icon';
        }
    }
    if (item.protected && isMgmt && !isRootFolder) {
        icon.className = hasChildren ? 'ph ph-folder-lock item-icon' : 'ph ph-file-lock item-icon';
    }

    // APLICAR COR DE STATUS AO ÍCONE E TEXTO
    const stats = getNodeStats(item.id);
    let iconColor = 'var(--text-main)';

    if (!hasChildren) {
        // Documento Folha
        if (item.isNotApplicable) {
            iconColor = 'var(--text-muted)';
        } else if (item.attachments && item.attachments.length > 0) {
            const status = (item.validationStatus || '').trim().toLowerCase();
            if (status === 'validado' || status === 'apf check') iconColor = 'var(--accent)';
            else if (status === 'apontamento') iconColor = 'var(--danger)';
            else iconColor = 'var(--warning)'; // Aguardando validação APF
        } else {
            iconColor = 'var(--danger)'; // Pendente de entrega
        }
    } else {
        // Pasta ou Subpasta
        if (stats.total > 0) {
            if (isRootFolder) {
                // Pasta de Setor: Apenas verde se tudo estiver validado, caso contrário mantém cor padrão
                if (stats.total === stats.validated) iconColor = 'var(--accent)';
                else iconColor = 'var(--text-main)';
            } else {
                // Subpastas: Vermelho se houver erro OU falta de entrega, Amarelo se estiver aguardando validação
                if (stats.apontamento > 0 || stats.pendente > 0) iconColor = 'var(--danger)';
                else if (stats.total === stats.validated) iconColor = 'var(--accent)';
                else iconColor = 'var(--warning)'; // Aguardando validação APF
            }
        }
    }
    icon.style.color = iconColor;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name text-truncate';
    if (item.isNotApplicable) {
        nameSpan.style.textDecoration = 'line-through';
        nameSpan.style.opacity = '0.7';
    }
    if (isRootFolder) {
        nameSpan.classList.add('root-name');
        if (stats.total > 0 && stats.total === stats.validated) {
            nameSpan.style.color = 'var(--accent)';
        }
    }

    nameSpan.title = 'Clique para Expandir ou Ocultar';
    nameSpan.appendChild(chevron);
    nameSpan.appendChild(icon);

    nameSpan.onclick = () => {
        if (hasChildren) {
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




    // Espaçador sutil para manter o alinhamento sem os indicadores
    if (isRootFolder && localUI.currentProjectId !== 'p_default') {
        const spacer = document.createElement('div');
        spacer.style.width = '20px';
        spacer.style.flexShrink = '0';
        itemLeft.prepend(spacer);
    }

    const nameWrapper = document.createElement('div');
    nameWrapper.className = 'name-wrapper';
    nameWrapper.appendChild(nameSpan);
    itemLeft.appendChild(nameWrapper);

    // Container para informações extras abaixo do nome (Justificativa, etc)
    const itemMeta = document.createElement('div');
    itemMeta.className = 'item-meta';
    nameWrapper.appendChild(itemMeta);
    const itemRight = document.createElement('div');
    itemRight.className = 'item-right';

    // RESTAURADO: LOCK ICON FOR ROOT FOLDERS - Right Aligned
    if (isRootFolder && localUI.currentProjectId !== 'p_default') {
        const isLocked = authenticatedSector && authenticatedSector !== 'APF' && authenticatedSector !== 'Olé' && authenticatedSector.trim() !== item.name.trim();
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

    if (!isMgmt) {
        if (!isRootFolder && !hasChildren) {
            const hasAtt = item.attachments && item.attachments.length > 0;
            const statusRow = document.createElement('div');
            statusRow.className = 'item-status-row';

            if (item.isNotApplicable) {
                const naBadge = document.createElement('span');
                naBadge.className = 'badge badge-na badge-sm';
                naBadge.textContent = 'Dispensado';
                statusRow.appendChild(naBadge);
            }

            const btnAttach = document.createElement('button');
            btnAttach.className = 'icon-btn attach-icon-btn';
            btnAttach.title = 'Anexar documento';
            btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
            btnAttach.onclick = (e) => {
                e.stopPropagation();
                activeUploadItemId = item.id;
                isUploadPendencia = false;
                if (globalFileInput) globalFileInput.click();
            };

            if (item.isNotApplicable) {
                btnAttach.disabled = true;
                btnAttach.style.opacity = '0.5';
                btnAttach.title = currProj.id === 'p_default' ? 'Anexar documento' : 'Documento dispensado';
            }

            if (!canEdit) {
                btnAttach.style.display = 'none';
            }

            // Justificativa / Observação (Sempre disponível para folhas)
            const btnJustify = document.createElement('button');
            btnJustify.className = 'btn btn-outline btn-sm btn-just-toggle';
            btnJustify.id = `btn-just-${item.id}`;
            btnJustify.innerHTML = '<i class="ph ph-chat-text"></i> Justificativa ou Observação';
            
            const updateJustifyBtnStyle = () => {
                if (btnJustify) {
                    if (item.justification && item.justification.trim() !== '') {
                        btnJustify.classList.add('has-content');
                    } else {
                        btnJustify.classList.remove('has-content');
                    }
                }
            };
            updateJustifyBtnStyle();

            if (!canEdit) {
                btnJustify.disabled = true;
                btnJustify.style.opacity = '0.5';
            }

            const justBox = document.createElement('div');
            justBox.className = 'justification-box';
            
            const justContainer = document.createElement('div');
            justContainer.className = 'justification-container';

            const justTitle = document.createElement('div');
            justTitle.className = 'justification-title';
            justTitle.innerHTML = '<i class="ph ph-chat-text" style="color:var(--warning)"></i> Justificativa ou Observação:';
            justContainer.appendChild(justTitle);

            const justInput = document.createElement('textarea');
            justInput.className = 'input-modern justification-input';
            justInput.placeholder = 'Escreva a justificativa ou observação aqui...';
            justInput.value = item.justification || '';
            justInput.oninput = (e) => {
                item.justification = e.target.value;
                updateJustifyBtnStyle();
            };

            const btnSaveJust = document.createElement('button');
            btnSaveJust.className = 'btn btn-primary btn-sm btn-save-just';
            btnSaveJust.innerHTML = '<i class="ph ph-check"></i> Salvar';
            btnSaveJust.onclick = (e) => {
                e.stopPropagation();
                if (item.justification && item.justification.trim() !== '') {
                    const oldStatus = item.validationStatus;
                    item.validationStatus = 'Em Análise de APF';
                    if (oldStatus !== 'Em Análise de APF') {
                        addAuditLog('Status de Validação', `Status de <strong>${item.name}</strong> alterado para "Análise" devido à nova justificativa`, 'warning');
                    }
                }
                saveState();
                renderTree();
                btnSaveJust.innerHTML = '<i class="ph ph-check-circle"></i> Salvo';
                setTimeout(() => { btnSaveJust.innerHTML = '<i class="ph ph-check"></i> Salvar'; }, 2000);
            };

            if (!canEdit) {
                justInput.disabled = true;
                btnSaveJust.style.display = 'none';
            }

            justContainer.appendChild(justInput);
            justContainer.appendChild(btnSaveJust);
            justBox.appendChild(justContainer);

            btnJustify.onclick = (e) => {
                e.stopPropagation();
                const isOpen = justBox.classList.toggle('open');
                btnJustify.classList.toggle('active', isOpen);
            };

            itemMeta.appendChild(btnJustify);
            itemMeta.appendChild(justBox);

            if (hasAtt) {
                statusRow.appendChild(btnAttach);
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
                if (item.forecastDate) {
                    forecastInput.value = item.forecastDate;
                    forecastInput.classList.add('has-value');
                }
                forecastInput.onchange = (e) => {
                    item.forecastDate = e.target.value;
                    saveState();
                };
                if (!canEdit) forecastInput.disabled = true;

                forecastGroup.innerHTML = '<label style="font-size:0.75rem; color:var(--text-muted);">Prev:</label>';
                forecastGroup.appendChild(forecastInput);

                pendingBar.appendChild(forecastGroup);
                pendingBar.appendChild(btnAttach);
                itemRight.appendChild(pendingBar);
            }
            itemRight.appendChild(statusRow);

            itemDiv.addEventListener('dragover', (e) => { e.preventDefault(); itemDiv.classList.add('drag-over'); });
            itemDiv.addEventListener('dragleave', (e) => { itemDiv.classList.remove('drag-over'); });
            itemDiv.addEventListener('drop', (e) => {
                e.preventDefault(); itemDiv.classList.remove('drag-over');
                if (!item.isNotApplicable && e.dataTransfer.files && e.dataTransfer.files.length > 0) window.handleFileUpload(item.id, e.dataTransfer.files);
            });
        }
    } else {
        if (!isRootFolder) {
            const mgmtFields = document.createElement('div');
            mgmtFields.className = 'management-fields';
            const isAPF = authenticatedSector === 'APF';

            if (item.attachments && item.attachments.length > 0) {
                const statusBtnGroup = createStatusButtonGroup(item, (newStatus) => {
                    const oldStatus = item.validationStatus;
                    item.validationStatus = newStatus;
                    saveState();
                    updateGlobalDateUI();
                    renderTree();
                    addAuditLog('Status de Validação', `Status de <strong>${item.name}</strong> alterado de "${oldStatus || 'Pendente'}" para "${item.validationStatus}"`, 'warning');
                    
                    // Notificar no Teams caso mude para Apontamento e já exista uma observação salva
                    if (newStatus === 'Apontamento' && item.observation && item.observation.trim() !== '') {
                        const sectorName = getItemSector(item.id) || 'Geral';
                        const currProj = getCurrentProject();
                        const projectName = currProj?.name || 'Desconhecido';
                        
                        sendTeamsNotification(sectorName, {
                            projectName: projectName,
                            documentName: item.name,
                            details: item.observation
                        });
                    }
                });

                mgmtFields.appendChild(statusBtnGroup);

                if (item.validationStatus === 'Apontamento') {
                    const btnObsToggle = document.createElement('button');
                    btnObsToggle.className = 'btn btn-outline btn-sm btn-just-toggle danger';
                    btnObsToggle.id = `btn-obs-${item.id}`;
                    btnObsToggle.innerHTML = '<i class="ph ph-warning-diamond"></i> Descrever Apontamento';
                    
                    const obsBox = document.createElement('div');
                    obsBox.className = 'justification-box';
                    
                    const obsContainer = document.createElement('div');
                    obsContainer.className = 'justification-container danger';

                    const obsTitle = document.createElement('div');
                    obsTitle.className = 'justification-title';
                    obsTitle.innerHTML = '<i class="ph ph-warning-diamond" style="color:var(--danger)"></i> Detalhes do Apontamento:';
                    obsContainer.appendChild(obsTitle);

                    const obsInp = document.createElement('textarea');
                    obsInp.className = 'input-modern justification-input';
                    obsInp.placeholder = 'Descreva aqui o motivo do apontamento ou o que precisa ser corrigido...';
                    obsInp.value = item.observation || '';
                    
                    const btnSaveObs = document.createElement('button');
                    btnSaveObs.className = 'btn btn-danger btn-sm btn-save-just';
                    btnSaveObs.innerHTML = '<i class="ph ph-check"></i> Salvar Apontamento';

                    const updateObsBtnStyle = () => {
                        if (btnObsToggle) {
                            if (item.observation && item.observation.trim() !== '') {
                                btnObsToggle.classList.add('has-content');
                            } else {
                                btnObsToggle.classList.remove('has-content');
                            }
                        }
                    };
                    updateObsBtnStyle();

                    obsInp.oninput = (e) => {
                        item.observation = e.target.value;
                        updateObsBtnStyle();
                    };

                    btnSaveObs.onclick = (e) => {
                        e.stopPropagation();
                        
                        const obsValue = obsInp.value.trim();
                        item.observation = obsValue;
                        updateObsBtnStyle();
                        
                        saveState();
                        
                        // Envia a notificação imediatamente antes do redesenho da árvore para garantir integridade do DOM
                        if (obsValue !== '') {
                            const sectorName = getItemSector(item.id) || 'Geral';
                            const currProj = getCurrentProject();
                            const projectName = currProj?.name || 'Desconhecido';
                            
                            sendTeamsNotification(sectorName, {
                                projectName: projectName,
                                documentName: item.name,
                                details: obsValue
                            });
                        }

                        renderTree();
                        
                        // Dar o feedback visual de salvo
                        const newlyRenderedBtn = document.querySelector(`.btn-save-just`);
                        if (newlyRenderedBtn) {
                            newlyRenderedBtn.innerHTML = '<i class="ph ph-check-circle"></i> Salvo';
                            setTimeout(() => { newlyRenderedBtn.innerHTML = '<i class="ph ph-check"></i> Salvar Apontamento'; }, 2000);
                        } else {
                            btnSaveObs.innerHTML = '<i class="ph ph-check-circle"></i> Salvo';
                            setTimeout(() => { btnSaveObs.innerHTML = '<i class="ph ph-check"></i> Salvar Apontamento'; }, 2000);
                        }

                        if (obsValue !== '') {
                            addAuditLog('Apontamento', `Novo apontamento em <strong>${item.name}</strong>: "${obsValue}"`, 'danger');
                        }
                    };

                    btnObsToggle.onclick = (e) => {
                        e.stopPropagation();
                        const isOpen = obsBox.classList.toggle('open');
                        btnObsToggle.classList.toggle('active', isOpen);
                    };

                    obsContainer.appendChild(obsInp);
                    obsContainer.appendChild(btnSaveObs);
                    obsBox.appendChild(obsContainer);
                    
                    mgmtFields.appendChild(btnObsToggle);
                    mgmtFields.appendChild(obsBox);

                    // NOVO: Exibir Resposta do Setor para a APF (Se houver)
                    if (item.response) {
                        const respBadge = document.createElement('div');
                        respBadge.className = 'sync-response-badge';
                        respBadge.innerHTML = `<strong>Resposta do Setor:</strong> ${item.response}`;
                        mgmtFields.appendChild(respBadge);
                    }
                }
            } else {
                mgmtFields.className = 'mgmt-info-stack';

                const statusRow = document.createElement('div');
                statusRow.className = 'mgmt-status-row';

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
                naLabel.appendChild(document.createTextNode('Dispensado'));

                statusRow.appendChild(statusText);
                if (currProj && currProj.id !== 'p_default') {
                    statusRow.appendChild(naLabel);
                }
                mgmtFields.appendChild(statusRow);

                // NOVO: Exibir Previsão e Justificativa para a APF (Se houver)
                if (item.forecastDate || item.justification) {
                    const infoArea = document.createElement('div');
                    infoArea.className = 'sync-info-area';

                    if (item.forecastDate) {
                        const dateBadge = document.createElement('div');
                        dateBadge.className = 'badge badge-sm';
                        dateBadge.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
                        dateBadge.style.color = 'var(--danger)';
                        dateBadge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                        dateBadge.innerHTML = `<i class="ph ph-calendar"></i> PREVISÃO: ${item.forecastDate.split('-').reverse().join('/')}`;
                        infoArea.appendChild(dateBadge);
                    }

                    if (item.justification && item.justification.trim() !== '') {
                        // NOVO: Justificativa agora em botão expansível também na visão APF
                        const btnShowJust = document.createElement('button');
                        btnShowJust.className = 'btn btn-outline btn-sm btn-just-view-toggle has-content';
                        btnShowJust.innerHTML = '<i class="ph ph-chat-text"></i> Ver Justificativa ou Observação';
                        
                        const justViewBox = document.createElement('div');
                        justViewBox.className = 'justification-view-box';
                        
                        const justText = document.createElement('div');
                        justText.className = 'sync-justification-text';
                        justText.innerHTML = `<i class="ph ph-chat-text" style="color:var(--warning)"></i> <strong>Justificativa ou Observação:</strong> ${item.justification}`;
                        
                        justViewBox.appendChild(justText);
                        
                        btnShowJust.onclick = (e) => {
                            e.stopPropagation();
                            const isOpen = justViewBox.classList.toggle('open');
                            btnShowJust.classList.toggle('active', isOpen);
                            btnShowJust.innerHTML = isOpen ? '<i class="ph ph-x"></i> Fechar Justificativa' : '<i class="ph ph-chat-text"></i> Ver Justificativa ou Observação';
                        };

                        itemMeta.appendChild(btnShowJust);
                        itemMeta.appendChild(justViewBox);
                    }
                    mgmtFields.appendChild(infoArea);
                }
            }
            itemRight.appendChild(mgmtFields);

            // Divisória vertical
            const divider = document.createElement('div');
            divider.className = 'mgmt-divider';
            itemRight.appendChild(divider);
        }

        // NOVO: Sistema de Menu de Edição (Refatoração solicitada pelo usuário)
        const gridActions = document.createElement('div');
        gridActions.className = 'node-mgmt-actions';

        const isAPF = authenticatedSector === 'APF';
        
        // 1. Botão de Anexo (Mantido visível se for documento)
        if (isAPF && !hasChildren && currProj.id !== 'p_default') {
            const btnAttach = document.createElement('button');
            btnAttach.className = 'icon-btn attach-icon-btn';
            btnAttach.title = 'Anexar documento';
            btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
            btnAttach.onclick = (e) => {
                e.stopPropagation();
                activeUploadItemId = item.id;
                isUploadPendencia = false;
                if (globalFileInput) globalFileInput.click();
            };
            if (item.isNotApplicable) {
                btnAttach.disabled = true;
                btnAttach.style.opacity = '0.5';
            }
            gridActions.appendChild(btnAttach);
        }

        // 2. Menu de Edição (Dropdown)
        const editMenuWrapper = document.createElement('div');
        editMenuWrapper.className = 'edit-menu-wrapper';

        const btnEditToggle = document.createElement('button');
        btnEditToggle.className = 'icon-btn edit-toggle-btn';
        btnEditToggle.innerHTML = '<i class="ph ph-note-pencil"></i>';
        btnEditToggle.title = 'Opções de Edição';
        
        const dropdown = document.createElement('div');
        dropdown.className = 'edit-actions-dropdown hidden';

        // Botões Internos do Menu
        const btnAddSub = document.createElement('button');
        btnAddSub.className = 'dropdown-item';
        btnAddSub.innerHTML = '<i class="ph ph-folder-plus"></i> Criar subpasta';
        btnAddSub.onclick = (e) => { e.stopPropagation(); dropdown.classList.add('hidden'); handleAddFolder(item.id); };

        const btnRename = document.createElement('button');
        btnRename.className = 'dropdown-item';
        btnRename.innerHTML = '<i class="ph ph-pencil-simple"></i> Renomear item';
        btnRename.onclick = (e) => { e.stopPropagation(); dropdown.classList.add('hidden'); handleRenameFolder(item.id); };

        const btnDel = document.createElement('button');
        btnDel.className = 'dropdown-item delete';
        btnDel.innerHTML = '<i class="ph ph-trash"></i> Excluir item';
        btnDel.onclick = (e) => { e.stopPropagation(); dropdown.classList.add('hidden'); handleDeleteFolder(item.id); };

        dropdown.appendChild(btnAddSub);
        dropdown.appendChild(btnRename);
        dropdown.appendChild(btnDel);

        btnEditToggle.onclick = (e) => {
            e.stopPropagation();
            const isOpen = !dropdown.classList.contains('hidden');
            
            // Fechar outros menus abertos e remover classes de destaque
            document.querySelectorAll('.edit-actions-dropdown').forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.tree-item').forEach(ti => ti.classList.remove('menu-open'));

            if (!isOpen) {
                dropdown.classList.remove('hidden');
                itemDiv.classList.add('menu-open');
                
                // Fechar ao clicar fora (Apenas uma vez ao abrir)
                const closeHandler = () => {
                    dropdown.classList.add('hidden');
                    itemDiv.classList.remove('menu-open');
                    window.removeEventListener('click', closeHandler);
                };
                setTimeout(() => window.addEventListener('click', closeHandler), 10);
            }
        };

        editMenuWrapper.appendChild(btnEditToggle);
        editMenuWrapper.appendChild(dropdown);
        gridActions.appendChild(editMenuWrapper);

        itemRight.appendChild(gridActions);
    }

    itemDiv.appendChild(itemLeft);
    itemDiv.appendChild(itemRight);

    // NOVO: Listagem de Anexos Vertical (Agora dentro do quadro do item/pasta)
    if (item.attachments && item.attachments.length > 0) {
        const attContainer = document.createElement('div');
        attContainer.className = 'node-attachments-container';
        item.attachments.forEach(att => {
            const badge = createAttachmentBadge(att, item.id, canEdit, isMgmt, false);
            attContainer.appendChild(badge);
        });
        itemDiv.appendChild(attContainer);
    }

    nodeWrapper.appendChild(itemDiv);

    if (!isMgmt && !isRootFolder && !hasChildren && item.validationStatus === 'Apontamento' && item.observation) {
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
        respInput.onchange = (e) => { 
            item.response = e.target.value; 
            if (item.response && item.response.trim() !== '') {
                item.validationStatus = 'Em Análise de APF';
                addAuditLog('Resposta ao Apontamento', `Setor respondeu ao apontamento em <strong>${item.name}</strong>. Status alterado para Análise.`, 'info');
            }
            saveState(); 
            updateGlobalDateUI();
            renderTree();
        };
        if (!canEdit) {
            respInput.disabled = true;
            respInput.placeholder = 'Apenas o setor responsável pode responder.';
        }
        respArea.appendChild(respInput);
        obsBox.appendChild(respArea);
        nodeWrapper.appendChild(obsBox);
    }

    if (nodeChildren.length > 0) {
        const childCont = document.createElement('div');
        childCont.className = 'children-container';
        nodeChildren.forEach(c => {
            const childNode = createNode(c, level + 1);
            if (childNode) childCont.appendChild(childNode);
        });
        nodeWrapper.appendChild(childCont);
    }

    return nodeWrapper;
}

// Logic implementations
function handleAddFolder(parentId) {
    // Permission Check
    if (authenticatedSector !== 'APF') {
        if (parentId === null) {
            showTemporaryMessage("Apenas APF pode criar novos setores raízes.");
            return;
        }
        const targetSector = getItemSector(parentId);
        if (targetSector !== authenticatedSector) {
            showTemporaryMessage(`Acesso negado. Você só pode adicionar itens ao setor "${authenticatedSector}".`);
            return;
        }
    }

    const parentItem = parentId ? getItems().find(i => i.id === parentId) : null;
    const name = prompt('Nome da nova pasta/item:');
    if (name && name.trim()) {
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
        if (parentItem) parentItem.expanded = true;
        saveState();
        renderTree();
    }
}

function handleDeleteFolder(id) {
    // Permission Check
    if (authenticatedSector !== 'APF') {
        const targetSector = getItemSector(id);
        if (targetSector !== authenticatedSector) {
            showTemporaryMessage("Acesso negado. Você não tem permissão para excluir itens de outros setores.");
            return;
        }
    }

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
                    if (ids.has(i.parentId) && !ids.has(i.id)) { ids.add(i.id); foundNew = true; }
                });
            } while (foundNew);

            const proj = getCurrentProject();
            proj.items = proj.items.filter(i => !ids.has(i.id));
            saveState();
            renderTree();
            showTemporaryMessage("Pasta removida com sucesso.");
        }
    });
}

function handleRenameFolder(id) {
    // Permission Check
    if (authenticatedSector !== 'APF') {
        const targetSector = getItemSector(id);
        if (targetSector !== authenticatedSector) {
            showTemporaryMessage("Acesso negado. Você não tem permissão para renomear itens de outros setores.");
            return;
        }
    }

    const item = getItems().find(i => i.id === id);
    if (!item) return;
    const newName = prompt('Novo nome para a pasta/item:', item.name);
    if (newName && newName.trim() && newName.trim() !== item.name) {
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
    const items = p.items || [];
    const rootSectors = ["APF", ...new Set(items.filter(i => i.parentId === null).map(i => i.name).sort())];

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
        input.style.opacity = '0.6';
        input.style.cursor = 'not-allowed';
        input.readOnly = true;
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

        const btnEdit = document.createElement('button');
        btnEdit.className = 'icon-btn';
        btnEdit.style.padding = '0.25rem';
        btnEdit.title = 'Editar senha';
        btnEdit.innerHTML = '<i class="ph ph-pencil-simple"></i>';

        btnEdit.onclick = () => {
            const isLocked = input.readOnly;
            input.readOnly = !isLocked;
            if (!input.readOnly) {
                input.style.opacity = '1';
                input.style.cursor = 'text';
                input.focus();
                btnEdit.innerHTML = '<i class="ph ph-check" style="color:var(--accent)"></i>';
                btnEdit.title = 'Concluir edição';
            } else {
                input.style.opacity = '0.6';
                input.style.cursor = 'not-allowed';
                btnEdit.innerHTML = '<i class="ph ph-pencil-simple"></i>';
                btnEdit.title = 'Editar senha';
            }
        };

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(btnEdit);
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

    if (pendenciaStartDateInp) {
        pendenciaStartDateInp.value = curr.pendenciaStartDate || '';
    }
    listCont.innerHTML = '';

    if (!curr.pendencias || curr.pendencias.length === 0) {
        listCont.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 1rem;">Nenhuma pendência crítica cadastrada.</p>';
        return;
    }

    // Agrupar pendências por setor
    const pendenciasPorSetor = {};
    curr.pendencias.forEach(p => {
        const sectorName = p.sector || 'Geral';
        if (!pendenciasPorSetor[sectorName]) {
            pendenciasPorSetor[sectorName] = [];
        }
        pendenciasPorSetor[sectorName].push(p);
    });

    const sortedSectors = Object.keys(pendenciasPorSetor).sort();

    if (!localUI.expandedMgmtPendenciasSectors) {
        localUI.expandedMgmtPendenciasSectors = new Set();
    }

    sortedSectors.forEach(sectorName => {
        const pendenciasDoSetor = pendenciasPorSetor[sectorName];
        const isExpanded = localUI.expandedMgmtPendenciasSectors.has(sectorName);

        const sectorNode = document.createElement('div');
        sectorNode.className = `tree-node ${isExpanded ? '' : 'collapsed'}`;
        sectorNode.style.marginBottom = '0.75rem';

        const sectorItem = document.createElement('div');
        sectorItem.className = 'tree-item';
        sectorItem.style.cursor = 'pointer';

        // Lado Esquerdo do item de setor (Chevron + Ícone + Nome do Setor)
        const itemLeft = document.createElement('div');
        itemLeft.className = 'item-left';

        const chevron = document.createElement('i');
        chevron.className = 'ph ph-caret-down';
        chevron.style.marginRight = '0.5rem';

        const icon = document.createElement('i');
        let iconClass = 'ph-folder';
        const n = sectorName.toLowerCase();
        if (n.includes('legaliza')) iconClass = 'ph-scales';
        else if (n.includes('arquit') || n.includes('urbani')) iconClass = 'ph-compass-tool';
        else if (n.includes('engenh')) iconClass = 'ph-wrench';
        else if (n.includes('sustent')) iconClass = 'ph-leaf';
        icon.className = `ph ${iconClass} item-icon`;

        // Estatísticas do setor de pendências
        const total = pendenciasDoSetor.length;
        const entregues = pendenciasDoSetor.filter(p => p.attachments && p.attachments.length > 0).length;
        const validadas = pendenciasDoSetor.filter(p => p.attachments && p.attachments.length > 0 && (p.validationStatus === 'Validado' || p.validationStatus === 'APF check')).length;
        const apontamentos = pendenciasDoSetor.filter(p => p.validationStatus === 'Apontamento').length;

        // Definir cor do ícone
        let iconColor = 'rgba(239, 68, 68, 0.85)';
        if (total === validadas) {
            iconColor = 'rgba(16, 185, 129, 0.85)';
        } else if (total === entregues) {
            iconColor = 'rgba(245, 158, 11, 0.85)';
        } else if (apontamentos > 0) {
            iconColor = 'rgba(239, 68, 68, 0.85)';
        }
        icon.style.color = iconColor;

        const nameWrapper = document.createElement('div');
        nameWrapper.className = 'name-wrapper';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'item-name text-truncate root-name';
        nameSpan.style.display = 'flex';
        nameSpan.style.alignItems = 'center';
        nameSpan.style.gap = '0.5rem';
        nameSpan.style.fontSize = '1.05rem';
        nameSpan.style.fontWeight = '700';

        nameSpan.appendChild(chevron);
        nameSpan.appendChild(icon);

        const titleText = document.createTextNode(' ' + sectorName);
        nameSpan.appendChild(titleText);

        nameWrapper.appendChild(nameSpan);
        itemLeft.appendChild(nameWrapper);

        // Lado Direito do item de setor (Contadores de progresso e indicador de pendência)
        const itemRight = document.createElement('div');
        itemRight.className = 'item-right';

        // Badge de progresso (ex: "1/3 Entregues")
        const progBadge = document.createElement('span');
        progBadge.className = entregues === total ? 'badge badge-validado badge-sm' : 'badge badge-analise badge-sm';
        progBadge.textContent = `${entregues}/${total} Entregues`;
        itemRight.appendChild(progBadge);

        // Se houver apontamentos, exibir badge de apontamento
        if (apontamentos > 0) {
            const apBadge = document.createElement('span');
            apBadge.className = 'badge badge-apontamento badge-sm';
            apBadge.textContent = `${apontamentos} Apontamento(s)`;
            itemRight.appendChild(apBadge);
        }

        // Se houver pendências críticas não entregues, exibir contador vermelho
        const naoEntregues = total - entregues;
        if (naoEntregues > 0) {
            const pendCircle = document.createElement('span');
            pendCircle.className = 'pending-circle';
            pendCircle.textContent = naoEntregues;
            itemRight.appendChild(pendCircle);
        }

        sectorItem.appendChild(itemLeft);
        sectorItem.appendChild(itemRight);

        // Clique no setor para alternar expansão
        sectorItem.onclick = () => {
            if (localUI.expandedMgmtPendenciasSectors.has(sectorName)) {
                localUI.expandedMgmtPendenciasSectors.delete(sectorName);
            } else {
                localUI.expandedMgmtPendenciasSectors.add(sectorName);
            }
            saveLocalUI();
            renderPendenciasMgmt();
        };

        sectorNode.appendChild(sectorItem);

        // Container de filhos para as pendências de gestão
        const childCont = document.createElement('div');
        childCont.className = 'children-container';

        pendenciasDoSetor.forEach(p => {
            const row = document.createElement('div');
            row.className = 'pendencia-mgmt-row';
            if (editingPendenciaId === p.id) row.style.borderColor = 'var(--warning)';

            // Borda colorida conforme o status na gestão também!
            let borderCol = 'rgba(var(--primary-rgb), )';
            const hasAtt = p.attachments && p.attachments.length > 0;
            if (hasAtt) {
                if (p.validationStatus === 'Validado' || p.validationStatus === 'APF check') {
                    borderCol = 'rgba(16, 185, 129, 0.4)';
                } else if (p.validationStatus === 'Apontamento') {
                    borderCol = 'rgba(239, 68, 68, 0.4)';
                } else {
                    borderCol = 'rgba(245, 158, 11, 0.4)';
                }
            } else {
                borderCol = 'rgba(239, 68, 68, 0.2)'; // Borda vermelha sutil para pendente
            }
            row.style.borderLeft = `2px solid ${borderCol}`;

            row.innerHTML = `
                <div style="display: flex; flex-direction: column; flex: 1; min-width: 0;">
                    <strong style="font-size: 0.85rem; color: white; white-space: normal; word-break: break-word;">${p.docName}</strong>
                    <span style="font-size: 0.7rem; color: var(--text-muted);">${p.sector}</span>
                    ${p.specification ? `<span style="font-size: 0.7rem; color: var(--primary); font-style: italic; margin-top: 0.15rem; white-space: normal; word-break: break-word;">Obs: ${p.specification}</span>` : ''}
                </div>
                
                <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                    <div class="mgmt-controls-group status-btns-container" style="display: flex; gap: 0.4rem; align-items: center;">
                        <!-- Botões de status inseridos via JS -->
                    </div>
                    ${p.attachments && p.attachments.length > 0 && p.validationStatus === 'Apontamento' ? `
                        <input type="text" class="input-modern btn-sm pendencia-obs-inp" style="max-width: 150px; padding: 0.2rem 0.4rem; font-size: 0.75rem;" placeholder="Qual apontamento?" value="${p.observation || ''}">
                    ` : ''}
                    ${!(p.attachments && p.attachments.length > 0) ? '<span style="font-size: 0.7rem; color: var(--text-muted); font-style: italic;">Sem anexo</span>' : ''}
                </div>

                <div style="display: flex; gap: 0.3rem; align-items: center;">
                    <button class="icon-btn attach-icon-btn attach-pend-mgmt" title="Anexar documento de pendência">
                        <i class="ph ph-paperclip"></i>
                    </button>
                    <button class="icon-btn edit" title="Editar Pendência">
                        <i class="ph ph-pencil-simple"></i>
                    </button>
                    <button class="icon-btn delete" title="Remover Pendência">
                        <i class="ph ph-trash"></i>
                    </button>
                </div>
            `;

            row.querySelector('.attach-pend-mgmt').onclick = (e) => {
                e.stopPropagation();
                activeUploadItemId = p.id;
                isUploadPendencia = true;
                if (globalFileInput) globalFileInput.click();
            };

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
                        addAuditLog('Pendência Removida', `A pendência <strong>${p.docName}</strong> do setor <strong>${p.sector}</strong> foi removida.`, 'danger');
                        saveState();
                        renderPendenciasMgmt();
                        renderTree();
                        showTemporaryMessage("Pendência removida.");
                    }
                });
            };

            if (p.attachments && p.attachments.length > 0) {
                const attContainer = document.createElement('div');
                attContainer.className = 'node-attachments-container';
                attContainer.style.paddingLeft = '0'; // alinhado à esquerda
                attContainer.style.marginTop = '0.5rem';
                p.attachments.forEach(att => {
                    const badge = createAttachmentBadge(att, p.id, true, true, true);
                    attContainer.appendChild(badge);
                });
                const leftCol = row.firstElementChild;
                if (leftCol) {
                    leftCol.appendChild(attContainer);
                }
            }

            // Bind events for the new validation controls
            const statusContainer = row.querySelector('.status-btns-container');
            if (statusContainer && p.attachments && p.attachments.length > 0) {
                const btns = createStatusButtonGroup(p, (newStatus) => {
                    p.validationStatus = newStatus;
                    saveState();
                    updateGlobalDateUI();
                    renderPendenciasMgmt();
                    renderTree();
                    
                    // Notificar no Teams caso a pendência mude para Apontamento e já tenha observação
                    if (newStatus === 'Apontamento' && p.observation && p.observation.trim() !== '') {
                        const sectorName = p.sector || 'Geral';
                        const currProj = getCurrentProject();
                        const projectName = currProj?.name || 'Desconhecido';
                        
                        sendTeamsNotification(sectorName, {
                            projectName: projectName,
                            documentName: p.docName,
                            details: p.observation
                        });
                    }
                });
                statusContainer.appendChild(btns);
            }

            const obsInp = row.querySelector('.pendencia-obs-inp');
            if (obsInp) {
                obsInp.oninput = (e) => {
                    const oldVal = p.observation || '';
                    p.observation = e.target.value;
                    saveState();
                };
                obsInp.onblur = () => {
                    renderTree();
                    if (p.observation) {
                        addAuditLog('Apontamento de Pendência', `Novo apontamento em <strong>${p.docName}</strong>: "${p.observation}"`, 'warning');
                        
                        // Notificar no Teams ao desfocar (terminar de escrever o apontamento da pendência)
                        if (p.validationStatus === 'Apontamento') {
                            const sectorName = p.sector || 'Geral';
                            const currProj = getCurrentProject();
                            const projectName = currProj?.name || 'Desconhecido';
                            
                            sendTeamsNotification(sectorName, {
                                projectName: projectName,
                                documentName: p.docName,
                                details: p.observation
                            });
                        }
                    }
                };
            }

            childCont.appendChild(row);
        });

        sectorNode.appendChild(childCont);
        listCont.appendChild(sectorNode);
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
    while (currentId) {
        const item = getItems().find(i => i.id === currentId);
        if (!item) break;
        const name = sanitize ? sanitizePathSegment(item.name) : item.name;
        path.unshift(name);
        currentId = item.parentId;
    }
    return path.join('/');
}

window.handleFileUpload = async function (itemId, files, isPendencia = false) {
    const currProject = getCurrentProject();
    if (!currProject || !files || files.length === 0) return;

    let targetItem;
    if (isPendencia) {
        targetItem = currProject.pendencias.find(p => p.id === itemId);
    } else {
        targetItem = getItems().find(i => i.id === itemId);
    }

    // Permission Check
    const isOleUser = authenticatedSector === 'Olé';
    const isOleProject = !!currProject.isOle;

    if (authenticatedSector !== 'APF') {
        const itemSector = isPendencia ? targetItem?.sector : getItemSector(itemId);
        const hasOleUnrestrictedAccess = isOleUser && isOleProject;

        const itemSectorNormalized = (itemSector || '').trim().toLowerCase();
        const userSectorNormalized = (authenticatedSector || '').trim().toLowerCase();

        if (itemSectorNormalized !== userSectorNormalized && !hasOleUnrestrictedAccess) {
            showTemporaryMessage(`Acesso negado. Você só pode enviar documentos para o setor "${authenticatedSector}".`);
            return;
        }
    }

    if (targetItem && currProject) {
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
            if (!targetItem.attachments) targetItem.attachments = [];

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
                        size: fileToUpload.size,
                        storagePath: fbStoragePath,
                        downloadUrl: downloadUrl,
                        objectUrl: downloadUrl,
                        source: 'firebase'
                    });

                    // Atualizar cache local de armazenamento em tempo real
                    state.storageBytes = (state.storageBytes || 0) + fileToUpload.size;
                    state.storageFileCount = (state.storageFileCount || 0) + 1;
                    updateFirebaseStorageUI();

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
            if (globalFileInput) globalFileInput.value = ''; // Reset global input
        }
    }
}

window.handleDeleteFile = async function (itemId, fileId, isPendencia = false) {
    // Permission Check
    const currProject = getCurrentProject();
    const isOleUser = authenticatedSector === 'Olé';
    const isOleProject = !!currProject?.isOle;

    if (authenticatedSector !== 'APF') {
        const itemSector = isPendencia ? currProject?.pendencias.find(p => p.id === itemId)?.sector : getItemSector(itemId);
        const hasOleUnrestrictedAccess = isOleUser && isOleProject;

        const itemSectorNormalized = (itemSector || '').trim().toLowerCase();
        const userSectorNormalized = (authenticatedSector || '').trim().toLowerCase();

        if (itemSectorNormalized !== userSectorNormalized && !hasOleUnrestrictedAccess) {
            showTemporaryMessage("Acesso negado. Você não tem permissão para excluir documentos de outros setores.");
            return;
        }
    }

    if (!currProject) return;

    let targetItem;
    if (isPendencia) {
        targetItem = currProject.pendencias.find(p => p.id === itemId);
    } else {
        targetItem = getItems().find(i => i.id === itemId);
    }

    if (targetItem && targetItem.attachments) {
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
                    // Atualizar cache local de armazenamento em tempo real
                    if (att.size !== undefined && typeof att.size === 'number') {
                        state.storageBytes = Math.max(0, (state.storageBytes || 0) - att.size);
                    }
                    state.storageFileCount = Math.max(0, (state.storageFileCount || 0) - 1);
                    updateFirebaseStorageUI();

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
window.openPreview = function (fileObj) {
    const url = fileObj.downloadUrl || fileObj.objectUrl;
    if (url) {
        window.open(url, '_blank');
    }
}


function initAIEngine() {
    const btnRefresh = document.getElementById('btn-refresh-analysis');
    if (btnRefresh) {
        btnRefresh.onclick = async () => {
            btnRefresh.querySelector('i').style.animation = 'spin 0.6s linear';
            
            // Buscar dados atualizados do projeto ativo no Firestore
            const curr = getCurrentProject();
            if (curr && curr.id !== 'none' && curr.id !== 'p_default') {
                console.log(`Atualizando dados do projeto ${curr.id} do Firestore...`);
                const projectDocRef = doc(db, `projects/${curr.id}`);
                try {
                    const snap = await getDoc(projectDocRef);
                    if (snap.exists()) {
                        const fullData = snap.data();
                        curr.items = fullData.items || [];
                        Object.assign(curr, fullData);
                        localStorage.setItem(CACHE_KEY, JSON.stringify(state));
                        renderAfterUpdate();
                        showTemporaryMessage("Dados do empreendimento atualizados com sucesso!");
                    } else {
                        renderAnalysisPanels();
                    }
                } catch (e) {
                    console.error("Erro ao atualizar projeto:", e);
                    renderAnalysisPanels();
                }
            } else {
                renderAnalysisPanels();
            }
            
            setTimeout(() => { if (btnRefresh.querySelector('i')) btnRefresh.querySelector('i').style.animation = ''; }, 700);
        };
    }
}

// Auxiliary function to get grade and status label
function getGrade(pct) {
    if (pct >= 90) return { g: 'A', color: 'var(--accent)', label: 'Excelente', bg: 'rgba(52,211,153,0.15)' };
    if (pct >= 70) return { g: 'B', color: '#60a5fa', label: 'Bom', bg: 'rgba(96,165,250,0.15)' };
    if (pct >= 50) return { g: 'C', color: 'var(--warning)', label: 'Regular', bg: 'rgba(245,158,11,0.15)' };
    if (pct >= 25) return { g: 'D', color: '#fb923c', label: 'Baixo', bg: 'rgba(251,146,60,0.15)' };
    return { g: 'F', color: 'var(--danger)', label: 'Crítico', bg: 'rgba(239,68,68,0.12)' };
}

function renderAnalysisPanels() {
    const sectorsEl = document.getElementById('panel-sectors');
    const wrapperEl = document.querySelector('.analysis-panels-wrapper');
    if (!sectorsEl) return;

    // NOVO: Esconde o painel lateral para usuários não-APF conforme solicitado
    if (authenticatedSector !== 'APF') {
        if (wrapperEl) wrapperEl.style.display = 'none';
        return;
    } else {
        if (wrapperEl) wrapperEl.style.display = 'flex';
    }

    updateHistorySidebarVisibility();

    // ---- PAINEL: Análise por Setor (projeto selecionado) ----
    const nonBase = state.projects.filter(p => p.id !== 'p_default');
    const curr = getCurrentProject();
    if (!curr || curr.id === 'p_default' || nonBase.length === 0) {
        sectorsEl.innerHTML = '<div style="text-align:center; padding:1.25rem; color:var(--text-muted); font-size:0.82rem;"><i class="ph ph-chart-pie" style="font-size:1.5rem; opacity:0.4;"></i><br><br>Selecione um empreendimento para ver a análise por setor.</div>';
        return;
    }

    const items = curr.items || [];
    const roots = items.filter(i => i.parentId === null).sort((a, b) => a.name.localeCompare(b.name));
    if (roots.length === 0) {
        sectorsEl.innerHTML = '<div style="text-align:center; padding:1rem; color:var(--text-muted); font-size:0.82rem;">Nenhum setor encontrado.</div>';
        return;
    }

    // Cabeçalho com nome do projeto em destaque no Painel
    const projHeader = `<div style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.8rem; padding-bottom:0.5rem; border-bottom:1px solid var(--divider-color); display:flex; align-items:center; gap:0.4rem;">
        <i class="ph ph-buildings"></i>
        <span style="font-weight:700; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${curr.name}</span>
    </div>`;

    const sectorsHtml = roots.map(root => {
        let total = 0, delivered = 0, apontamentos = 0;
        const countItems = (itemId) => {
            items.filter(i => i.parentId === itemId).forEach(child => {
                const hasChildren = items.some(i => i.parentId === child.id);
                if (!hasChildren) {
                    if (child.isNotApplicable) return;
                    total++;
                    if (child.attachments && child.attachments.length > 0) {
                        if (child.validationStatus !== 'Apontamento') {
                            delivered++;
                        } else {
                            apontamentos++;
                        }
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
            <div class="adaptive-card" style="padding:0.65rem 0.75rem; margin-bottom:0.4rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.35rem; gap:0.5rem;">
                    <div class="sector-name-wrapper">
                        <span class="sector-name-text">${root.name}</span>
                    </div>
                    <span style="font-size:0.7rem; font-weight:800; color:${grade.color}; background:${grade.bg}; padding:0.15rem 0.45rem; border-radius:0.3rem; border:1px solid ${grade.color}44; white-space:nowrap;">${grade.g} - ${grade.label}</span>
                </div>
                <div class="progress-track" style="height:4px; margin-bottom:0.35rem; overflow:hidden;">
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
        if (geminiModelInp) geminiModelInp.value = localStorage.getItem('apf_gemini_model') || 'gemini-2.5-flash';
        if (geminiKeyInp) geminiKeyInp.value = localStorage.getItem('apf_gemini_key') || '';

        renderSectorPasswordsSettings();
        if (settingsModal) settingsModal.classList.remove('hidden');
    }

    // History Modal Events
    if (btnShowHistory) {
        btnShowHistory.onclick = () => {
            localUI.showHistorySidebar = !localUI.showHistorySidebar;
            saveLocalUI();
            updateHistorySidebarVisibility();
            renderProjectHistory();
        };
    }
    if (btnCloseHistory) {
        btnCloseHistory.onclick = () => historyModal.classList.add('hidden');
    }
    if (historyModal) {
        historyModal.onclick = (e) => { if (e.target === historyModal) historyModal.classList.add('hidden'); };
    }

    btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
    settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

    btnResetModel.addEventListener('click', () => {
        geminiModelInp.value = 'gemini-2.5-flash';
        geminiModelInp.style.backgroundColor = 'rgba(var(--primary-rgb), )';
        setTimeout(() => geminiModelInp.style.backgroundColor = '', 500);
    });

    btnToggleKey.addEventListener('click', () => {
        const isPass = geminiKeyInp.type === 'password';
        geminiKeyInp.type = isPass ? 'text' : 'password';
        btnToggleKey.innerHTML = `<i class="ph ph-eye${isPass ? '-slash' : ''}"></i>`;
    });


    btnSaveSettings.addEventListener('click', () => {
        const gModel = geminiModelInp ? geminiModelInp.value.trim() : '';
        const gKey = geminiKeyInp ? geminiKeyInp.value.trim() : '';
        const aPass = apfPassInp ? apfPassInp.value.trim() : '';

        if (gModel) localStorage.setItem('apf_gemini_model', gModel);
        if (gKey) localStorage.setItem('apf_gemini_key', gKey); else localStorage.removeItem('apf_gemini_key');
        if (aPass) localStorage.setItem('apf_access_password', aPass); else localStorage.removeItem('apf_access_password');

        alert('Configurações salvas com sucesso!');
        settingsModal.classList.add('hidden');
    });
}

window.analyzeDocumentAI = async function (att) {
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
        if (!apiKey) {
            throw new Error("API Key não configurada. Por favor, acesse as Configurações (ícone ⚙️).");
        }
        // Fix: Using configured model name
        const aiUrl = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`;

        if (!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(mimeType)) {
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

        if (!aiRes.ok) {
            const isAuthErr = aiRes.status === 401 || aiRes.status === 403;
            if (isAuthErr) localStorage.removeItem('apf_gemini_key');
            throw new Error('Falha na autenticação ou processamento do Google (verifique o modelo e a chave).');
        }
        const data = await aiRes.json();
        const textOut = data.candidates[0].content.parts[0].text;

        const formattedHtml = textOut.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent);">$1</strong>').replace(/\n/g, '<br>');

        body.innerHTML = `<div style="text-align:left; color:white; font-size:0.95rem; line-height:1.6; padding: 1rem; width: 100%; white-space: break-spaces;">${formattedHtml}</div>`;

    } catch (e) {
        console.error(e);
        body.innerHTML = `<div style="padding:2rem; text-align:center; color:var(--danger)">
            <i class="ph ph-warning-circle" style="font-size: 2.5rem; margin-bottom: 1rem; display: block;"></i>
            <p>${e.message}</p>
            <p style="font-size: 0.8rem; margin-top: 1rem; opacity: 0.7;">Nota: Verifique se sua chave de API do Gemini ainda é válida.</p>
        </div>`;
    }
}

window.autoAnalyzeDocumentAI = async function (att, itemId, originalFile = null, isPendencia = false) {
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
    renderProjectHistory();
}

function updateHistorySidebarVisibility() {
    const btn = document.getElementById('btn-show-history');
    const panelChecklist = document.getElementById('aside-project-history');
    const panelMgmt = document.getElementById('aside-project-history-mgmt');
    if (!btn) return;

    const isAPF = (authenticatedSector === 'APF');

    if (localUI.showHistorySidebar) {
        btn.classList.add('active');
        if (isAPF) {
            if (panelMgmt) panelMgmt.style.display = 'flex';
            if (panelChecklist) panelChecklist.style.display = 'none';
        } else {
            if (panelMgmt) panelMgmt.style.display = 'none';
            if (panelChecklist) panelChecklist.style.display = 'flex';
        }
    } else {
        btn.classList.remove('active');
        if (panelChecklist) panelChecklist.style.display = 'none';
        if (panelMgmt) panelMgmt.style.display = 'none';
    }
}

function renderProjectHistory() {
    const containerChecklist = document.getElementById('panel-project-history');
    const containerMgmt = document.getElementById('panel-project-history-mgmt');
    if (!containerChecklist && !containerMgmt) return;

    const curr = getCurrentProject();

    const buildHtml = () => {
        if (!curr || curr.id === 'p_default') {
            return '<div style="text-align:center; padding:1.25rem; color:var(--text-muted); font-size:0.82rem;">Selecione um empreendimento para ver o histórico.</div>';
        }

        const logs = (state.auditLog || []).filter(log => log.projectId === curr.id);

        if (logs.length === 0) {
            return '<div style="text-align:center; padding:1.25rem; color:var(--text-muted); font-size:0.82rem;">Nenhuma ação registrada para este projeto.</div>';
        }

        return logs.map(log => {
            const date = new Date(log.timestamp);
            const day = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
            const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

            let typeClass = '';
            let iconAction = 'ph-info';
            if (log.type === 'danger') { typeClass = 'danger'; iconAction = 'ph-warning-circle'; }
            else if (log.type === 'warning') { typeClass = 'warning'; iconAction = 'ph-warning-diamond'; }
            else if (log.type === 'success') { typeClass = 'success'; iconAction = 'ph-check-circle'; }

            return `
                <div class="audit-entry-compact ${typeClass}">
                    <div class="audit-row-action">
                        <i class="ph ${iconAction}"></i> ${log.action}
                    </div>
                    <div class="audit-row-time">
                        <i class="ph ph-user-focus"></i> ${log.sector || 'Sistema'} | ${time} - ${day}
                    </div>
                    <div class="audit-row-desc">
                        ${log.details}
                    </div>
                </div>
            `;
        }).join('');
    };

    const html = buildHtml();
    if (containerChecklist) containerChecklist.innerHTML = html;
    if (containerMgmt) containerMgmt.innerHTML = html;
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

window.generateProjectReportAI = async function () {
    const curr = getCurrentProject();
    if (!curr || curr.id === 'none') {
        alert('Selecione um empreendimento primeiro.');
        return;
    }

    const apiKey = localStorage.getItem('apf_gemini_key');
    const modelName = localStorage.getItem('apf_gemini_model') || 'gemini-1.5-flash';
    if (!apiKey) {
        alert('API Key do Gemini não configurada. Por favor, acesse as Configurações (ícone ⚙️).');
        return;
    }

    document.getElementById('preview-title').innerHTML = `<i class="ph ph-sparkle" style="color:var(--accent);"></i> Relatório do Empreendimento (IA): ${curr.name}`;
    document.getElementById('preview-download-btn').style.display = 'none';
    const body = document.getElementById('preview-body');

    body.innerHTML = `
        <div style="text-align:center; padding:4rem; color:var(--primary);">
            <i class="ph ph-sparkle ph-spin" style="font-size: 3rem; display:inline-block; animation-duration: 2s;"></i>
            <p style="margin-top:1rem;">A inteligência artificial está analisando as métricas do empreendimento...</p>
        </div>
    `;
    modalOverlay.classList.remove('hidden');

    try {
        // Collect Metrics
        const allItems = curr.items || [];
        const requiredItems = allItems.filter(i => {
            const hasChildren = allItems.some(child => child.parentId === i.id);
            return (i.parentId !== null && !hasChildren && !i.isNotApplicable);
        });

        const totalItems = requiredItems.length;
        const validated = requiredItems.filter(i => i.validationStatus === 'Validado').length;
        const apontamento = requiredItems.filter(i => i.validationStatus === 'Apontamento').length;
        const pendent = requiredItems.filter(i => !i.attachments || i.attachments.length === 0).length;

        let dueMsg = "Sem prazo geral definido";
        if (curr.dueDate) {
            const today = new Date().setHours(0, 0, 0, 0);
            const due = new Date(curr.dueDate + 'T00:00:00').getTime();
            const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
            if (diffDays < 0) {
                dueMsg = `Atrasado em ${Math.abs(diffDays)} dia(s)`;
            } else if (diffDays === 0) {
                dueMsg = "Prazo encerra hoje";
            } else {
                dueMsg = `Dentro do prazo (${diffDays} dia(s) restante(s))`;
            }
        }

        const metricsSummary = `Lugar/Empreendimento: ${curr.name}
Total de documentos exigidos: ${totalItems}
Documentos Validados: ${validated}
Documentos com Apontamento (Refazer/Corrigir): ${apontamento}
Documentos completamente Pendentes (Faltosos): ${pendent}
Status do Prazo: ${dueMsg}`;

        const aiUrl = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`;

        const payload = {
            contents: [{
                parts: [
                    { text: "Atue como um gerente de projetos rigoroso e analítico. A partir das métricas cruas a seguir sobre a entrega de documentação de um empreendimento, gere um resumo executivo objetivo e direto. Indique qual a etapa atual de saúde do projeto, mencione se há criticidade em relação aos atrasos ou pendências, e indique o que precisa de mais atenção. Use tom executivo. Devolva a resposta com uso de negrito para pontos importantes. Métricas:\\n\\n" + metricsSummary }
                ]
            }]
        };

        const aiRes = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!aiRes.ok) throw new Error('Falha na comunicação com o Gemini. Verifique a chave ou o modelo nas configurações.');
        const data = await aiRes.json();
        const textOut = data.candidates[0].content.parts[0].text;

        const formattedHtml = textOut.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent);">$1</strong>').replace(/\n/g, '<br>');

        body.innerHTML = `<div style="text-align:left; color:white; font-size:0.95rem; line-height:1.6; padding: 1rem; width: 100%; white-space: break-spaces;">${formattedHtml}</div>`;

    } catch (e) {
        console.error(e);
        body.innerHTML = `<div style="padding:2rem; text-align:center; color:var(--danger)">
            <i class="ph ph-warning-circle" style="font-size: 2.5rem; margin-bottom: 1rem; display: block;"></i>
            <p>${e.message}</p>
        </div>`;
    }
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

    // --- Plexus Background Logic ---
    initPlexusBackground();
});

/**
 * Inicializa o fundo interativo Plexus no Canvas
 */
function initPlexusBackground() {
    const canvas = document.getElementById('plexus-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let particles = [];
    const mouse = { x: null, y: null, radius: 150 };

    // Cores base solicitadas
    const particleColors = ['#ef4444', '#f59e0b', '#ffffff'];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        initParticles();
    }

    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 1;
            this.speedX = (Math.random() - 0.5) * 0.8;
            this.speedY = (Math.random() - 0.5) * 0.8;

            // Atribui uma cor aleatória do conjunto
            const colorIndex = Math.floor(Math.random() * particleColors.length);
            this.color = particleColors[colorIndex];
        }

        update() {
            this.x += this.speedX;
            this.y += this.speedY;

            if (this.x > canvas.width) this.x = 0;
            else if (this.x < 0) this.x = canvas.width;
            if (this.y > canvas.height) this.y = 0;
            else if (this.y < 0) this.y = canvas.height;

            // Interação com o mouse
            let dx = mouse.x - this.x;
            let dy = mouse.y - this.y;
            let distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < mouse.radius) {
                if (mouse.x < this.x && this.x < canvas.width - this.size * 10) this.x += 1;
                if (mouse.x > this.x && this.x > this.size * 10) this.x -= 1;
                if (mouse.y < this.y && this.y < canvas.height - this.size * 10) this.y += 1;
                if (mouse.y > this.y && this.y > this.size * 10) this.y -= 1;
            }
        }

        draw() {
            ctx.fillStyle = this.color;
            // Se estiver em modo claro, garantir que o branco não "suma"
            if (document.documentElement.classList.contains('light-mode') && this.color === '#ffffff') {
                ctx.fillStyle = '#94a3b8'; // Cinza azulado para pontos brancos no modo claro
            }
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function initParticles() {
        particles = [];
        const quantity = Math.floor((canvas.width * canvas.height) / 9000); // Densidade dinâmica
        for (let i = 0; i < Math.min(quantity, 150); i++) {
            particles.push(new Particle());
        }
    }

    function connect() {
        const isLight = document.documentElement.classList.contains('light-mode');
        const maxDistance = 150;

        for (let a = 0; a < particles.length; a++) {
            for (let b = a; b < particles.length; b++) {
                let dx = particles[a].x - particles[b].x;
                let dy = particles[a].y - particles[b].y;
                let distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < maxDistance) {
                    let opacity = 1 - (distance / maxDistance);
                    ctx.strokeStyle = isLight
                        ? `rgba(15, 23, 42, ${opacity * 0.15})`
                        : `rgba(255, 255, 255, ${opacity * 0.15})`;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(particles[a].x, particles[a].y);
                    ctx.lineTo(particles[b].x, particles[b].y);
                    ctx.stroke();
                }
            }
        }
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
            particles[i].draw();
        }
        connect();
        requestAnimationFrame(animate);
    }

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', (e) => {
        mouse.x = e.x;
        mouse.y = e.y;
    });
    window.addEventListener('mouseout', () => {
        mouse.x = null;
        mouse.y = null;
    });

    resize();
    animate();
}

// =========================================================================
// WIDGET DE ARMAZENAMENTO DO FIREBASE
// =========================================================================
const FIREBASE_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB em bytes
let isStorageCalculating = false;

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function calculateStorageFromFirebaseStorage() {
    console.log("[Firebase Storage] Iniciando varredura recursiva do bucket...");
    
    async function scanFolder(folderRef) {
        let bytes = 0;
        let files = 0;
        
        try {
            const res = await listAll(folderRef);
            
            // Obter metadados de todos os arquivos nesta pasta em paralelo
            const itemPromises = res.items.map(async (itemRef) => {
                try {
                    const meta = await getMetadata(itemRef);
                    return { size: meta.size || 0, count: 1 };
                } catch (err) {
                    console.warn(`[Firebase Storage] Erro ao obter metadados de ${itemRef.fullPath}:`, err);
                    return { size: 0, count: 0 };
                }
            });
            
            const itemResults = await Promise.all(itemPromises);
            for (const r of itemResults) {
                bytes += r.size;
                files += r.count;
            }
            
            // Processar subpastas recursivamente em paralelo
            if (res.prefixes && res.prefixes.length > 0) {
                const subfolderPromises = res.prefixes.map(prefixRef => scanFolder(prefixRef));
                const subfolderResults = await Promise.all(subfolderPromises);
                for (const r of subfolderResults) {
                    bytes += r.bytes;
                    files += r.files;
                }
            }
        } catch (err) {
            console.error(`[Firebase Storage] Erro ao listar a pasta ${folderRef.fullPath || 'raiz'}:`, err);
        }
        
        return { bytes, files };
    }
    
    // Tenta primeiro no root (ref(storage)), se falhar tenta na subpasta APF_Projetos
    try {
        const rootRef = ref(storage);
        const result = await scanFolder(rootRef);
        return result;
    } catch (e) {
        console.warn("[Firebase Storage] Falha ao escanear raiz do bucket. Tentando na subpasta APF_Projetos...", e);
        try {
            const apfRef = ref(storage, "APF_Projetos");
            const result = await scanFolder(apfRef);
            return result;
        } catch (subErr) {
            console.error("[Firebase Storage] Falha geral ao escanear bucket de armazenamento:", subErr);
            throw subErr;
        }
    }
}

async function updateFirebaseStorageUI(forceFetchAll = false) {
    const widget = document.getElementById('firebase-storage-widget');
    if (!widget) return;

    // Se o usuário não for do setor APF, oculta o widget
    if (authenticatedSector !== 'APF') {
        widget.style.display = 'none';
        return;
    }
    widget.style.display = 'block';

    const needsFetch = forceFetchAll || state.storageBytes === undefined || state.storageBytes === null;

    if (needsFetch && !isStorageCalculating) {
        isStorageCalculating = true;
        renderStorageWidget(widget, state.storageBytes || 0, state.storageFileCount || 0, true);

        // Processa de forma assíncrona para não travar a UI
        (async () => {
            try {
                const result = await calculateStorageFromFirebaseStorage();
                state.storageBytes = result.bytes;
                state.storageFileCount = result.files;
                
                console.log(`[Firebase Storage] Armazenamento total recalculado: ${formatBytes(state.storageBytes)} (${state.storageFileCount} arquivos)`);
                
                // Salvar o estado com os metadados calculados
                saveState();
            } catch (err) {
                console.error("[Firebase Storage] Erro ao calcular armazenamento total:", err);
            } finally {
                isStorageCalculating = false;
                renderStorageWidget(widget, state.storageBytes || 0, state.storageFileCount || 0, false);
            }
        })();
        return;
    }

    // Se já temos as informações calculadas (ou estamos calculando), apenas exibimos o cache
    renderStorageWidget(widget, state.storageBytes || 0, state.storageFileCount || 0, isStorageCalculating);
}

function renderStorageWidget(container, usedBytes, fileCount, isLoading) {
    const totalBytes = FIREBASE_STORAGE_LIMIT_BYTES;
    const usedPercentage = Math.min(100, (usedBytes / totalBytes) * 100);
    const freeBytes = Math.max(0, totalBytes - usedBytes);
    const freePercentage = 100 - usedPercentage;

    let barGradientClass = 'storage-gradient-safe';
    let statusText = 'Excelente';
    let statusColor = '#10b981'; // Verde

    if (usedPercentage > 85) {
        barGradientClass = 'storage-gradient-danger';
        statusText = 'Crítico';
        statusColor = '#ef4444'; // Vermelho
    } else if (usedPercentage > 65) {
        barGradientClass = 'storage-gradient-warning';
        statusText = 'Atenção';
        statusColor = '#f59e0b'; // Laranja
    }

    container.innerHTML = `
        <div class="storage-widget-header flex-between mb-2">
            <h4 class="storage-title">
                <i class="ph ph-cloud-arrow-up"></i> Armazenamento: <span class="font-semibold text-main ml-1">${formatBytes(usedBytes)}</span> <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal; margin-left:0.25rem;">/ ${formatBytes(totalBytes)}</span>
            </h4>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <div class="storage-badge" style="background: ${statusColor}15; color: ${statusColor}; border: 1px solid ${statusColor}25; font-size: 0.65rem; padding: 0.1rem 0.4rem;">
                    ${statusText}
                </div>
                <button id="btn-refresh-storage" class="storage-refresh-btn-minimal" title="Atualizar" ${isLoading ? 'disabled' : ''}>
                    <i class="ph ph-arrows-clockwise ${isLoading ? 'ph-spin' : ''}" style="font-size: 0.95rem;"></i>
                </button>
            </div>
        </div>

        <div class="storage-bar-track mb-2" style="height: 6px;">
            <div class="storage-bar-fill ${barGradientClass}" style="width: ${usedPercentage}%;"></div>
        </div>

        <div class="flex-between" style="font-size: 0.72rem; color: var(--text-muted);">
            <span>${usedPercentage.toFixed(1)}% utilizado • <b>${fileCount}</b> arquivos</span>
            <span>${formatBytes(freeBytes)} livres</span>
        </div>
    `;

    const btnRefresh = container.querySelector('#btn-refresh-storage');
    if (btnRefresh) {
        btnRefresh.onclick = (e) => {
            e.stopPropagation();
            console.log("[Firebase Storage] Atualização manual solicitada. Recalculando...");
            updateFirebaseStorageUI(true);
        };
    }
}

/**
 * Envia uma notificação premium para o canal do Microsoft Teams via Webhook
 * destacando explicitamente o setor afetado no título e no corpo do cartão.
 */
async function sendTeamsNotification(sector, data) {
    if (!TEAMS_WEBHOOK_URL) return;

    const formattedDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });

    const payload = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "themeColor": "EF4444",
        "summary": `🚨 Apontamento de Correção - Setor ${sector}`,
        "sections": [
            {
                "activityTitle": "🚨 **Novo Apontamento de Correção**",
                "activitySubtitle": `Setor Responsável: **${sector}** | Empreendimento: **${data.projectName}**`,
                "activityImage": "https://raw.githubusercontent.com/Robinho2503/APF---recebimento-de-docs/main/login_icon_new.png",
                "markdown": true
            },
            {
                "title": "📋 **Detalhes da Pendência**",
                "facts": [
                    { "name": "🏢 Empreendimento:", "value": `**${data.projectName}**` },
                    { "name": "📂 Setor Afetado:", "value": `**${sector}**` },
                    { "name": "📄 Documento:", "value": `_${data.documentName}_` },
                    { "name": "📅 Data do Registro:", "value": formattedDate },
                    { "name": "👤 Registrado por:", "value": "Administração APF" }
                ],
                "markdown": true
            },
            {
                "title": "💬 **Observações e Justificativa da APF**",
                "text": `> "${data.details}"`,
                "markdown": true
            }
        ],
        "potentialAction": [{
            "@type": "OpenUri",
            "name": "🔗 Abrir Checklist no Sistema",
            "targets": [{
                "os": "default",
                "uri": window.location.href
            }]
        }]
    };

    // Método 1: Tentar via Proxy Serverless da Vercel (Se hospedado lá)
    try {
        console.log("[Teams Webhook] Camada 1: Tentando via Proxy Serverless da Vercel...");
        const response = await fetch('/api/teams-webhook', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                webhookUrl: TEAMS_WEBHOOK_URL,
                payload: payload
            })
        });

        if (response.ok) {
            console.log(`[Teams Webhook] Notificação enviada via proxy Vercel com sucesso para o setor: ${sector}`);
            return;
        }
        
        console.warn(`[Teams Webhook] Proxy Vercel retornou status: ${response.status}. Acionando Camada 2...`);
    } catch (e) {
        console.warn("[Teams Webhook] Erro ao conectar com o Proxy da Vercel. Acionando Camada 2...", e);
    }

    // Método 2: Tentar via Proxy CORS Público Altamente Estável (corsproxy.io)
    // Isso garante funcionamento 100% imediato e contorna o CORS direto no navegador, mesmo em outras hospedagens ou localhost
    try {
        console.log("[Teams Webhook] Camada 2: Tentando enviar via CORSProxy.io...");
        const corsProxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(TEAMS_WEBHOOK_URL)}`;
        
        const response = await fetch(corsProxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`[Teams Webhook] Notificação enviada via CORSProxy com sucesso para o setor: ${sector}`);
            return;
        }
        
        console.warn(`[Teams Webhook] CORSProxy retornou status: ${response.status}. Acionando Camada 3 de fallback...`);
    } catch (e) {
        console.error("[Teams Webhook] Erro ao enviar via CORSProxy. Acionando Camada 3...", e);
    }

    // Método 3: Fallback direto no-cors (Último recurso)
    try {
        console.log("[Teams Webhook] Camada 3: Tentando envio direto com no-cors...");
        await fetch(TEAMS_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            mode: 'no-cors'
        });
        console.log("[Teams Webhook] Envio direto concluído (opaco/no-cors).");
    } catch (e) {
        console.error("[Teams Webhook] Falha definitiva no envio em todas as camadas:", e);
    }
}
