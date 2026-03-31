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
    currentProjectId: 'p_default'
};
let isAuthenticated = false;



// Helpers
function generateId() { return Math.random().toString(36).substr(2, 9); }
function getCurrentProject() { return state.projects.find(p => p.id === state.currentProjectId); }
function getItems() { return getCurrentProject()?.items || []; }
function isMgmtActive() {
    const activeTabObj = Array.from(tabs).find(t => t.classList.contains('active'));
    return activeTabObj && activeTabObj.dataset.tab === 'management';
}

// Persistence
async function loadState() {
    const saved = localStorage.getItem('apf_checklist_v2.2');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            
            for (const p of parsed.projects) {
                if (!p.createdAt) p.createdAt = new Date().toISOString().split('T')[0];
                if (p.engAnalysisOpened === undefined) p.engAnalysisOpened = false;
                if (p.pendenciaActive === undefined) p.pendenciaActive = false;
                if (!p.pendencias) p.pendencias = [];
                if (p.pendenciaStartDate === undefined) p.pendenciaStartDate = '';
                for (const item of p.items) {
                    if (item.attachments && item.attachments.length > 0) {
                        for (const att of item.attachments) {
                            if (att.dropboxUrl && !att.objectUrl) {
                                att.objectUrl = att.dropboxUrl;
                            }
                        }
                    }
                }
            }

            state = parsed;
            
            // Migration: Update old status labels
            state.projects.forEach(p => {
                p.items.forEach(item => {
                    if (item.validationStatus === 'Em Análise') item.validationStatus = 'Em Análise de APF';
                });
            });

            const defP = state.projects.find(p => p.id === 'p_default');
            if(defP && defP.name === 'Empreendimento Base') defP.name = 'Modelo de Entrega';

            if(!state.projects.find(p => p.id === state.currentProjectId)) {
                state.currentProjectId = state.projects[0].id;
            }
            if (parsed.showFullChecklistDuringPendencia === undefined) parsed.showFullChecklistDuringPendencia = false;
            state.showFullChecklistDuringPendencia = parsed.showFullChecklistDuringPendencia;
            
            // Re-render after loading files
            updateGlobalDateUI();
            renderTree();
            renderTracking();
        } catch(e) { console.error('Error loading state', e); }
    }
}

function saveState() {
    // We save the structure to localStorage, but files are already in IndexedDB
    const saveableState = {
        projects: state.projects.map(p => ({
            ...p,
            engAnalysisOpened: p.engAnalysisOpened || false,
            pendenciaActive: p.pendenciaActive || false,
            pendencias: (p.pendencias || []).map(pend => ({
                id: pend.id,
                docName: pend.docName,
                sector: pend.sector,
                specification: pend.specification || '',
                attachments: (pend.attachments || []).map(att => ({
                    id: att.id,
                    name: att.name,
                    type: att.type,
                    dropboxPath: att.dropboxPath,
                    dropboxUrl: att.dropboxUrl,
                    objectUrl: att.dropboxUrl
                })),
                observation: pend.observation || ''
            })),
            pendenciaStartDate: p.pendenciaStartDate || '',
            showFullChecklistDuringPendencia: p.showFullChecklistDuringPendencia || false,
            items: p.items.map(item => ({
                ...item,
                attachments: (item.attachments || []).map(att => ({
                    id: att.id,
                    name: att.name,
                    type: att.type,
                    dropboxPath: att.dropboxPath,
                    dropboxUrl: att.dropboxUrl,
                    objectUrl: att.dropboxUrl
                }))
            }))
        })),
        currentProjectId: state.currentProjectId
    };
    localStorage.setItem('apf_checklist_v2.2', JSON.stringify(saveableState));
}

// DOM Elements
// const projectSelect = document.getElementById('project-select'); // Removed
const btnNewProject = document.getElementById('btn-new-project');
const btnExportZip = document.getElementById('btn-export-zip');
const btnToggleEng = document.getElementById('btn-toggle-eng');
const btnDeleteProject = document.getElementById('btn-delete-project');
const btnRenameProject = document.getElementById('btn-rename-project');
const btnOpenTemplate = document.getElementById('btn-open-template');

const checklistContainer = document.getElementById('checklist-render-area');
const sidebarApf = document.getElementById('sidebar-apf');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const managementContainer = document.getElementById('management-render-area');
const trackingContainer = document.getElementById('tracking-render-area');
const btnLogout = document.getElementById('btn-logout');

const tabs = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

const passwordLock = document.getElementById('password-lock');
const managementContent = document.getElementById('management-content');
const inputPassword = document.getElementById('apf-password');
const btnUnlock = document.getElementById('btn-unlock');
const passwordError = document.getElementById('password-error');
const btnBackToMain = document.getElementById('btn-back-to-main');

const btnAddRoot = document.getElementById('btn-add-root');
const currentProjectName = document.getElementById('current-project-name');
const projectDueDateInp = document.getElementById('project-due-date');
const projectGlobalCountdown = document.getElementById('project-global-countdown');

const modalOverlay = document.getElementById('preview-modal');

// Init
document.addEventListener('DOMContentLoaded', async () => {
    // Theme setup
    if (localStorage.getItem('apf_theme') === 'light') {
        document.documentElement.classList.add('light-mode');
        const themeBtn = document.getElementById('btn-theme-toggle');
        if (themeBtn) themeBtn.innerHTML = '<i class="ph ph-moon"></i>';
    }

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

    initDropbox();
    await loadState(); // Now re-renders everything internally
    initAIEngine();
    initSettings();
});

const btnDbx = document.getElementById('btn-connect-dropbox');

// Authentication - Dropbox
function initDropbox() {
    const hash = window.location.hash;
    let token = localStorage.getItem('apf_dropbox_token');
    const dropboxAppKey = localStorage.getItem('apf_dropbox_app_key');
    
    if (hash && hash.includes('access_token')) {
        const params = new URLSearchParams(hash.substring(1));
        token = params.get('access_token');
        if (token) {
            localStorage.setItem('apf_dropbox_token', token);
            window.location.hash = ''; // Clear hash for clean URL
        }
    }
    
    if (token) {
        dbx = new window.Dropbox.Dropbox({ accessToken: token });
        if(btnDbx) {
            btnDbx.innerHTML = '<i class="ph ph-check-circle"></i>'; // Apenas ícone
            btnDbx.title = 'Dropbox Conectado';
            btnDbx.classList.remove('btn-outline');
            btnDbx.classList.add('glass-panel');
            btnDbx.style.color = 'var(--accent)';
            btnDbx.style.border = '1px solid var(--accent)';
            btnDbx.onclick = () => {
                if(confirm('Deseja desconectar sua conta do Dropbox?')) {
                    localStorage.removeItem('apf_dropbox_token');
                    location.reload();
                }
            };
        }
    } else {
        if(btnDbx) {
            btnDbx.onclick = () => {
                if (!dropboxAppKey) {
                    alert("Configuração Pendente: Por favor, insira sua 'Dropbox App Key' nas Configurações (ícone ⚙️) para habilitar a conexão.");
                    return;
                }

                let cleanPath = window.location.pathname.replace(/\/index\.html$/, '/');
                if (!cleanPath.endsWith('/')) cleanPath += '/';
                const redirectUri = window.location.origin + cleanPath;
                
                if (window.location.protocol === 'file:') {
                    alert("AVISO CRÍTICO:\n\nVocê está abrindo o projeto como um simples arquivo (file://).\nO Dropbox NÃO aceita esse tipo de endereço para realizar o login por segurança.\n\nPor favor, utilize o arquivo 'abrir_projeto.ps1' que eu criei na pasta do projeto para rodar o sistema no endereço http://localhost:8000 que é aceito pelo Dropbox.");
                    return;
                }

                alert("COPIE ESTE ENDEREÇO EXACTO:\n\n" + redirectUri + "\n\nCole lá no painel do Dropbox (OAuth 2 Redirect URIs) na aba Settings do seu App, ou o Dropbox vai negar o acesso com 'pedido inválido'.");

                const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${dropboxAppKey}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}`;
                window.location.href = authUrl;
            };
        }
    }
}

// Authentication
if (btnUnlock) {
    btnUnlock.addEventListener('click', () => {
        const storedPassword = localStorage.getItem('apf_access_password') || '1234';
        if(inputPassword.value === storedPassword) {
            isAuthenticated = true;
            inputPassword.value = '';
            passwordError.style.display = 'none';
            applyAuthState();
            renderTree();
        } else {
            passwordError.style.display = 'block';
            inputPassword.style.borderColor = 'var(--danger)';
            setTimeout(() => {
                inputPassword.style.borderColor = '';
            }, 1000);
        }
    });
}

// Allow Enter key to unlock
if (inputPassword) {
    inputPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') btnUnlock.click();
    });
}

if (btnBackToMain) {
    btnBackToMain.addEventListener('click', () => {
        // Fechar aba APF e mostrar checklist novamente
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));
        const checklistSection = document.getElementById('tab-checklist');
        if (checklistSection) checklistSection.style.display = '';
        applyAuthState();
        updateGlobalDateUI();
        renderTree();
        renderTracking();
    });
}

function applyAuthState() {
    if(!passwordLock || !managementContent) return;

    const tabsNav = document.querySelector('.tabs');
    const isMgmt = isMgmtActive();
    const apfSubmenu = document.getElementById('apf-submenu');
    const btnDetailedAi = document.getElementById('btn-detailed-ai');

    // Show APF tools only when in APF tab and authenticated
    if (apfSubmenu) apfSubmenu.style.display = (isMgmt && isAuthenticated) ? 'flex' : 'none';
    if (btnDetailedAi) btnDetailedAi.style.display = (isMgmt && isAuthenticated) ? 'inline-flex' : 'none';

    if (isMgmt) {
        // APF tab is active
        if (isAuthenticated) {
            passwordLock.style.display = 'none';
            managementContent.style.display = 'block';
            if (sidebarApf) sidebarApf.style.display = 'flex';
        } else {
            passwordLock.style.display = 'block';
            managementContent.style.display = 'none';
            if (sidebarApf) sidebarApf.style.display = 'none';
            if (inputPassword) inputPassword.focus();
        }
    } else {
        // Checklist is visible (default state) - lock screen hidden
        passwordLock.style.display = 'none';
        managementContent.style.display = 'none';
        if (sidebarApf) sidebarApf.style.display = 'flex';
    }
    if (tabsNav) tabsNav.style.display = 'flex';
}

// Tabs Navigation
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const alreadyActive = tab.classList.contains('active');

        // Toggle: clicar no tab ativo fecha e volta ao checklist
        if (alreadyActive) {
            tab.classList.remove('active');
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

        // Ocultar/mostrar o checklist fixo quando o APF é aberto
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

// Project Management & Global UI
function updateGlobalDateUI() {
    const curr = getCurrentProject();
    if(!curr) return;
    
    document.getElementById('checklist-proj-name').textContent = curr.name;
    if (currentProjectName) currentProjectName.textContent = curr.name;
    
    // Badge unificado no subtitle agora

    projectDueDateInp.value = curr.dueDate || '';
    
    const dueDateContainer = document.getElementById('due-date-container');
    if (dueDateContainer) {
        dueDateContainer.style.display = (curr.id === 'p_default') ? 'none' : 'flex';
    }

    if (btnToggleEng) {
        btnToggleEng.style.display = (curr.id === 'p_default') ? 'none' : 'inline-flex';
        btnToggleEng.className = curr.engAnalysisOpened ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
        btnToggleEng.innerHTML = curr.engAnalysisOpened ? '<i class="ph ph-check-circle"></i> Engenharia Aberta' : '<i class="ph ph-file-search"></i> Abrir Engenharia';
    }

    if (btnTogglePendencias) {
        btnTogglePendencias.style.display = (curr.id === 'p_default') ? 'none' : 'inline-flex';
    }

    if (btnDeleteProject) {
        btnDeleteProject.style.display = (curr.id === 'p_default') ? 'none' : 'inline-flex';
    }
    
    if (btnRenameProject) {
        btnRenameProject.style.display = (curr.id === 'p_default') ? 'none' : 'inline-flex';
    }
    
    const subtitleEl = document.getElementById('checklist-subtitle');
    if (subtitleEl) {
        subtitleEl.textContent = 'Entrega da documentação';
        subtitleEl.className = 'default-subtitle';
    }

    if(curr.engAnalysisOpened) {
        if (subtitleEl) {
            subtitleEl.innerHTML = '<i class="ph ph-file-search"></i> Engenharia Aberta';
            subtitleEl.className = 'badge-eng-subtitle';
        }
        projectGlobalCountdown.style.display = 'none';
    } else if(curr.dueDate) {
        let totalD = 0;
        let elapsedD = 0;
        if (curr.createdAt) {
            const tStart = new Date(curr.createdAt).getTime();
            const tEnd = new Date(curr.dueDate).getTime();
            const tNow = new Date().getTime();
            if (tEnd > tStart) {
                totalD = Math.ceil((tEnd - tStart) / (1000 * 60 * 60 * 24));
                elapsedD = Math.floor((tNow - tStart) / (1000 * 60 * 60 * 24));
                if (elapsedD < 0) elapsedD = 0;
            }
        }
        const diff = calculateDays(curr.dueDate);
        let diffStr = '';
        let bizDaysStr = ` (${calculateBusinessDays(curr.dueDate)} dias úteis)`;
        
        if (diff === 0) {
            diffStr = "Entrega Hoje";
            bizDaysStr = '';
        } else if (diff > 0) {
            diffStr = `Faltam ${diff} dia(s)`;
        } else {
            diffStr = `Atrasado ${Math.abs(diff)} dia(s)`;
            bizDaysStr = '';
        }
        
        if (subtitleEl) subtitleEl.textContent = `Prazo: ${formatDateToPT(curr.dueDate)} ┃ ${diffStr}${bizDaysStr}`;
        projectGlobalCountdown.style.display = 'none';
    } else {
        projectGlobalCountdown.style.display = 'none';
    }
}

projectDueDateInp.addEventListener('change', (e) => {
    const curr = getCurrentProject();
    if(curr && curr.id !== 'p_default') {
        curr.dueDate = e.target.value;
        saveState();
        updateGlobalDateUI();
        renderTracking();
    }
});

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
        state.currentProjectId = newProj.id;
        saveState();
        updateGlobalDateUI();
        renderTree();
        renderTracking();
        
        // Switch to Management tab to show the new project structure editor
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="management"]').classList.add('active');
        document.getElementById('tab-management').classList.add('active');
        unlockManagement();

        // projectInp.value = ''; // This variable doesn't exist in the provided context, commenting out.
    }
});

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

            // Add attachments
            if (item.attachments && item.attachments.length > 0) {
                for (const att of item.attachments) {
                    try {
                        const response = await fetch(att.objectUrl);
                        const blob = await response.blob();
                        itemFolder.file(att.name, blob);
                    } catch (e) {
                        console.error(`Erro ao baixar arquivo ${att.name}:`, e);
                    }
                }
            }

            // Process children
            for (const child of children) {
                await processItem(child, itemFolder);
            }
        }

        const roots = getChildItems(null);
        if (roots.length === 0) {
            alert('Não há itens para exportar.');
            btnExportZip.innerHTML = originalBtnContent;
            btnExportZip.disabled = false;
            return;
        }

        for (const root of roots) {
            await processItem(root, rootFolder);
        }

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

btnDeleteProject.addEventListener('click', () => {
    if (state.currentProjectId === 'p_default') {
        alert('O Modelo de Entrega não pode ser excluído.');
        return;
    }
    const curr = getCurrentProject();
    if(confirm(`Atenção: Tem certeza que deseja excluir o empreendimento "${curr.name}" completamente?`)){
        state.projects = state.projects.filter(p => p.id !== state.currentProjectId);
        // Fallback to the first project that isn't the template, or the template if none left
        const nextProj = state.projects.find(p => p.id !== 'p_default') || state.projects[0];
        state.currentProjectId = nextProj.id;
        saveState();
        updateGlobalDateUI();
        renderTree();
        renderTracking();
    }
});

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
            renderTracking(); // Essential to update sidebar
        }
    });
}

if (btnOpenTemplate) {
    btnOpenTemplate.addEventListener('click', () => {
        if(state.currentProjectId === 'p_default') return;
        state.currentProjectId = 'p_default';
        saveState();
        updateGlobalDateUI();
        renderTree();
        renderTracking();
        triggerPanelAnimation();
    });
}

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
        const isActive = p.id === state.currentProjectId ? 'active' : '';
        const isEng = p.engAnalysisOpened ? 'eng-active' : '';
        const isPendencia = p.pendenciaActive ? 'pendencia-active' : '';
        card.className = `tracking-card glass-panel ${isActive} ${isEng} ${isPendencia}`;
        
        card.addEventListener('click', () => {
            if(state.currentProjectId === p.id) return;
            state.currentProjectId = p.id;
            saveState();
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
            trackingLine = `<span style="color: #713f12; font-weight: 700; display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-file-search"></i> Engenharia Aberta</span>`;
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

        card.innerHTML = `
            <div class="tracking-body">
                <div class="mb-1 flex-between" style="align-items: center; gap: 0.5rem;">
                    <h3 style="font-weight:700; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; margin: 0;" title="${p.name}"><i class="ph ph-buildings text-primary"></i> ${p.name}</h3>
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
    let pendente = 0;
    let apontamento = 0;
    
    const item = getItems().find(i => i.id === itemId);
    if(item && item.parentId !== null) {
        if(!item.attachments || item.attachments.length === 0) pendente++;
        if(item.validationStatus === 'Apontamento') apontamento++;
    }
    
    const children = getChildItems(itemId);
    children.forEach(child => {
        const childStats = getNodeStats(child.id);
        pendente += childStats.pendente;
        apontamento += childStats.apontamento;
    });
    
    return { pendente, apontamento };
}

function renderTree() {
    checklistContainer.innerHTML = '';
    managementContainer.innerHTML = '';
    
    const currProj = getCurrentProject();
    const mgmt = isMgmtActive();
    
    // Always sync panel references
    const pMgmtPanel = document.getElementById('pendencias-mgmt-panel');
    const pToggleBtn = document.getElementById('btn-toggle-pendencias');

    if (!mgmt && (!currProj || currProj.id === 'none' || currProj.id === 'p_default')) {
        let msg = '<i class="ph ph-warning"></i> Selecione um Empreendimento acima para visualizar a documentação.';
        if(state.projects.length <= 1) msg = '<i class="ph ph-warning"></i> Você precisa criar um Empreendimento novo na aba "Acesso APF" para manipular os checklists.';
        checklistContainer.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding: 3rem 1rem; border: 1px dashed var(--panel-border); border-radius: 0.5rem;">${msg}</div>`;
        return;
    }

    // Sync panel visibility with proj state
    if (pMgmtPanel && pToggleBtn) {
        const shouldShow = mgmt && currProj && currProj.id !== 'p_default' && currProj.pendenciaActive;
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

    renderPendenciasChecklist(currProj);

    const rootItems = getChildItems(null);
    
    // Logic to hide sectors when Pendências is active
    let showItems = true;
    if (currProj && currProj.pendenciaActive) {
        if (!state.showFullChecklistDuringPendencia) showItems = false;
        
        const toggleDiv = document.createElement('div');
        toggleDiv.style.margin = '1.5rem 0 1rem';
        toggleDiv.style.textAlign = 'center';
        
        const btnToggleFull = document.createElement('button');
        btnToggleFull.className = 'btn btn-outline btn-sm';
        btnToggleFull.innerHTML = state.showFullChecklistDuringPendencia 
            ? '<i class="ph ph-eye-slash"></i> Ocultar Documentação dos Setores' 
            : '<i class="ph ph-eye"></i> Exibir Documentação dos Setores';
        
        btnToggleFull.onclick = () => {
            state.showFullChecklistDuringPendencia = !state.showFullChecklistDuringPendencia;
            saveState();
            renderTree();
        };
        
        toggleDiv.appendChild(btnToggleFull);
        checklistContainer.appendChild(toggleDiv);
    }

    rootItems.forEach((item) => {
        const c1 = createNode(item, false);
        const c2 = createNode(item, true);
        if (showItems) checklistContainer.appendChild(c1);
        managementContainer.appendChild(c2);
    });

    updateProjectProgressUI(currProj);
    renderAnalysisPanels();
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
        statusRow.appendChild(statusBadge);

        // Attach Button
        const btnAttach = document.createElement('button');
        btnAttach.className = 'icon-btn attach-icon-btn';
        btnAttach.title = 'Anexar documento de pendência';
        btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
        
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.className = 'hidden';
        fileInput.multiple = true;
        fileInput.onchange = (e) => window.handleFileUpload(e.target.files, p.id, true);
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
        obsInput.onchange = (e) => { p.observation = e.target.value; saveState(); };
        
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
    
    // Count items that are subfolders/items, ignoring top-level folders.
    const leafItems = curr.items.filter(i => i.parentId !== null);
    let progressPct = 0;
    if (leafItems.length > 0) {
        const deliveredCount = leafItems.filter(i => i.attachments && i.attachments.length > 0).length;
        progressPct = Math.round((deliveredCount / leafItems.length) * 100);
    }
    
    container.style.display = 'block';
    container.innerHTML = `
        <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; background: rgba(0,0,0,0.15); padding: 0.75rem 1rem; border-radius: 0.75rem;">
            <div class="circular-progress-container">
                <div class="circular-progress" style="--progress: ${progressPct}%;"></div>
                <span class="progress-text">${progressPct}%</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.2rem;">
                <span style="font-size: 0.95rem; font-weight: 600; color: var(--text-main);">Progresso de entrega</span>
                <span style="font-size: 0.8rem; color: var(--text-muted);">Documentação indexada no Checklist</span>
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

function formatDateToPT(isoStr) {
    if(!isoStr) return '';
    const parts = isoStr.split('-');
    if(parts.length !== 3) return isoStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function createNode(item, isMgmt) {
    const nodeWrapper = document.createElement('div');
    nodeWrapper.className = `tree-node ${item.expanded ? '' : 'collapsed'}`;

    const hasChildren = getChildItems(item.id).length > 0;
    const isRootFolder = item.parentId === null;

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
            item.expanded = !item.expanded;
            saveState();
            renderTree();
        }
    };

    const titleText = document.createTextNode(' ' + item.name);
    nameSpan.appendChild(titleText);

    // PENDING CIRCLE for ROOT FOLDERS
    if(isRootFolder && state.currentProjectId !== 'p_default') {
        const stats = getNodeStats(item.id);
        if (stats.pendente > 0) {
            const circle = document.createElement('span');
            circle.className = 'pending-circle';
            circle.textContent = stats.pendente;
            circle.title = `${stats.pendente} item(s) pendente(s)`;
            itemLeft.prepend(circle);
        }
    }

    itemLeft.appendChild(nameSpan);

    const itemRight = document.createElement('div');
    itemRight.className = 'item-right';

    if(!isMgmt) {
        // --- VISÃO GERAL ---
        if(!isRootFolder) {
            const hasAtt = item.attachments && item.attachments.length > 0;

            // FILE INPUT (hidden) - created once for this item
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.className = 'file-input-hidden';
            fileInput.multiple = true;
            fileInput.onchange = (e) => handleFileUpload(e.target.files, item.id);
            itemRight.appendChild(fileInput);

            // --- ROW 1: Status badges + icon-only attach button on the right ---
            const statusRow = document.createElement('div');
            statusRow.className = 'item-status-row';

            // Badges wrap (left side)
            const badgesWrap = document.createElement('div');
            badgesWrap.style.display = 'flex';
            badgesWrap.style.gap = '0.3rem';
            badgesWrap.style.flexWrap = 'wrap';
            badgesWrap.style.alignItems = 'center';

            // Delivery status badge (always shown)
            const statusBadge = document.createElement('span');
            statusBadge.className = hasAtt ? 'badge badge-entregue badge-sm' : 'badge badge-pendente badge-sm';
            statusBadge.textContent = hasAtt ? 'Entregue' : 'Pendente';
            badgesWrap.appendChild(statusBadge);

            // Validation badge ONLY if there is an attachment
            if(hasAtt && item.validationStatus) {
                const valBadge = document.createElement('span');
                if(item.validationStatus === 'Validado') valBadge.className = 'badge badge-validado badge-sm';
                else if(item.validationStatus === 'Apontamento') valBadge.className = 'badge badge-apontamento badge-sm';
                else valBadge.className = 'badge badge-analise badge-sm';
                valBadge.textContent = item.validationStatus;
                badgesWrap.appendChild(valBadge);
            }

            const btnAttach = document.createElement('button');
            btnAttach.className = 'icon-btn attach-icon-btn';
            btnAttach.title = 'Anexar documento';
            btnAttach.innerHTML = '<i class="ph ph-paperclip"></i>';
            btnAttach.onclick = () => fileInput.click();

            if (hasAtt) {
                statusRow.appendChild(btnAttach);
            }
            itemRight.appendChild(statusRow);

            // --- ROW 2: Inline attachments (only when files exist) ---
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

                    const btnAi = document.createElement('button');
                    btnAi.className = 'icon-btn';
                    btnAi.title = 'Extrair leitura do doc com IA';
                    btnAi.innerHTML = '<i class="ph ph-magic-wand text-primary"></i>';
                    btnAi.onclick = () => window.analyzeDocumentAI(att);

                    const btnView = document.createElement('button');
                    btnView.className = 'icon-btn';
                    btnView.title = 'Visualizar';
                    btnView.innerHTML = '<i class="ph ph-eye"></i>';
                    btnView.onclick = () => window.openPreview(att);
                    
                    const btnDown = document.createElement('a');
                    btnDown.className = 'icon-btn';
                    btnDown.title = 'Baixar';
                    btnDown.download = att.name;
                    btnDown.href = att.objectUrl;
                    btnDown.innerHTML = '<i class="ph ph-download-simple"></i>';
                    
                    const btnDel = document.createElement('button');
                    btnDel.className = 'icon-btn delete';
                    btnDel.title = 'Remover';
                    btnDel.innerHTML = '<i class="ph ph-x"></i>';
                    btnDel.onclick = () => window.handleDeleteFile(item.id, att.id);

                    attBadge.appendChild(nameTxt);
                    attBadge.appendChild(btnAi);
                    attBadge.appendChild(btnView);
                    attBadge.appendChild(btnDown);
                    attBadge.appendChild(btnDel);
                    inlineAttachments.appendChild(attBadge);
                });
                itemRight.appendChild(inlineAttachments);
            } else {
                // --- PENDING FIELDS (Horizontal) ---
                const pendingBar = document.createElement('div');
                pendingBar.className = 'pending-action-bar';

                // Previsão Input
                const forecastGroup = document.createElement('div');
                forecastGroup.style.display = 'flex';
                forecastGroup.style.alignItems = 'center';
                forecastGroup.style.gap = '0.3rem';

                const forecastLabel = document.createElement('label');
                forecastLabel.style.fontSize = '0.75rem';
                forecastLabel.style.color = 'var(--text-muted)';
                forecastLabel.textContent = 'Prev:';

                const forecastInput = document.createElement('input');
                forecastInput.type = 'date';
                forecastInput.className = 'input-modern';
                forecastInput.style.padding = '0.2rem 0.4rem';
                forecastInput.style.fontSize = '0.75rem';
                forecastInput.style.maxWidth = '105px';
                if(item.forecastDate) forecastInput.value = item.forecastDate;
                forecastInput.onchange = (e) => { item.forecastDate = e.target.value; saveState(); };

                forecastGroup.appendChild(forecastLabel);
                forecastGroup.appendChild(forecastInput);

                // Justification Toggle
                const btnJustify = document.createElement('button');
                btnJustify.className = 'btn btn-outline btn-sm';
                btnJustify.style.padding = '0.2rem 0.5rem';
                btnJustify.style.fontSize = '0.7rem';
                btnJustify.innerHTML = '<i class="ph ph-chat-text"></i> Justif.';
                
                // Justification Text Box (Keep it toggleable but smaller)
                const justBox = document.createElement('div');
                justBox.className = 'justification-box';
                const justInput = document.createElement('textarea');
                justInput.className = 'input-modern';
                justInput.style.width = '100%';
                justInput.style.height = '60px';
                justInput.style.fontSize = '0.75rem';
                justInput.placeholder = 'Justificativa...';
                if(item.justification) justInput.value = item.justification;
                justInput.onchange = (e) => { item.justification = e.target.value; saveState(); };
                justBox.appendChild(justInput);

                if(item.justification && item.justification.trim() !== '') {
                    btnJustify.style.borderColor = 'var(--primary)';
                    btnJustify.style.color = 'var(--primary)';
                }
                btnJustify.onclick = () => justBox.classList.toggle('open');

                pendingBar.appendChild(forecastGroup);
                pendingBar.appendChild(btnJustify);
                pendingBar.appendChild(btnAttach); // Use the same btnAttach defined above

                itemRight.appendChild(pendingBar);
                itemRight.appendChild(justBox); 
            }
            
            // File Drop Handlers (Drag & Drop)
            itemDiv.addEventListener('dragover', (e) => { e.preventDefault(); itemDiv.classList.add('drag-over'); });
            itemDiv.addEventListener('dragleave', (e) => { itemDiv.classList.remove('drag-over'); });
            itemDiv.addEventListener('drop', (e) => {
                e.preventDefault(); itemDiv.classList.remove('drag-over');
                if(e.dataTransfer.files && e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files, item.id);
            });
        }
    } else {
        // --- ACESSO APF (MGMT) ---
        if(!isRootFolder) {
            const mgmtFields = document.createElement('div');
            mgmtFields.className = 'management-fields';
            
            // Requisito: Mostrar menu apenas se houver anexo
            if (item.attachments && item.attachments.length > 0) {
                const valSelect = document.createElement('select');
                valSelect.className = 'input-modern btn-sm';
                valSelect.title = 'Status de Validação';
                valSelect.style.maxWidth = '160px';
                ['Em Análise de APF', 'Validado', 'Apontamento'].forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    if(item.validationStatus === opt) o.selected = true;
                    valSelect.appendChild(o);
                });
                valSelect.onchange = (e) => { item.validationStatus = e.target.value; saveState(); renderTree(); };
                mgmtFields.appendChild(valSelect);

                if(item.validationStatus === 'Apontamento') {
                    const obsInp = document.createElement('input');
                    obsInp.type = 'text';
                    obsInp.className = 'input-modern btn-sm';
                    obsInp.placeholder = 'Qual apontamento?';
                    obsInp.value = item.observation || '';
                    obsInp.oninput = (e) => { item.observation = e.target.value; saveState(); }; 
                    obsInp.onblur = () => renderTree();
                    mgmtFields.appendChild(obsInp);
                }
            } else {
                mgmtFields.innerHTML = '<span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">Aguardando documento...</span>';
            }
            itemRight.appendChild(mgmtFields);
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '0.4rem';
        actionsDiv.style.alignItems = 'center';

        const btnAddSub = document.createElement('button');
        btnAddSub.className = 'btn btn-outline btn-sm';
        btnAddSub.title = 'Nova Subpasta';
        btnAddSub.innerHTML = '<i class="ph ph-folder-plus"></i> <span style="margin-left:5px">Subpasta</span>';
        btnAddSub.onclick = () => handleAddFolder(item.id);
        actionsDiv.appendChild(btnAddSub);

        // Rename button (icon only) — shown for all items
        const btnRename = document.createElement('button');
        btnRename.className = 'icon-btn';
        btnRename.title = 'Renomear';
        btnRename.innerHTML = '<i class="ph ph-pencil-simple"></i>';
        btnRename.onclick = () => handleRenameFolder(item.id);
        actionsDiv.appendChild(btnRename);

        const btnDel = document.createElement('button');
        btnDel.className = 'icon-btn delete';
        btnDel.title = 'Excluir';
        btnDel.innerHTML = '<i class="ph ph-trash"></i>';
        btnDel.onclick = () => handleDeleteFolder(item.id);
        actionsDiv.appendChild(btnDel);

        itemRight.appendChild(actionsDiv);

        if(!isRootFolder && item.attachments && item.attachments.length > 0) {
            const inlineAttachments = document.createElement('div');
            inlineAttachments.style.display = 'flex';
            inlineAttachments.style.gap = '0.5rem';
            inlineAttachments.style.flexWrap = 'wrap';
            inlineAttachments.style.marginTop = '0.5rem';
            inlineAttachments.style.justifyContent = 'flex-end';
            inlineAttachments.style.flexShrink = '0';
            
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
                btnView.title = 'Visualizar';
                btnView.innerHTML = '<i class="ph ph-eye"></i>';
                btnView.onclick = () => window.openPreview(att);
                
                const btnAi = document.createElement('button');
                btnAi.className = 'icon-btn';
                btnAi.title = "Extrair leitura do doc com IA";
                btnAi.innerHTML = '<i class="ph ph-magic-wand text-primary"></i>';
                btnAi.onclick = () => window.analyzeDocumentAI(att);

                const btnDown = document.createElement('a');
                btnDown.className = 'icon-btn';
                btnDown.title = 'Baixar';
                btnDown.download = att.name;
                btnDown.href = att.objectUrl;
                btnDown.innerHTML = '<i class="ph ph-download-simple"></i>';
                
                attBadge.appendChild(nameTxt);
                attBadge.appendChild(btnAi);
                attBadge.appendChild(btnView);
                attBadge.appendChild(btnDown);
                inlineAttachments.appendChild(attBadge);
            });
            itemRight.appendChild(inlineAttachments);
        }
    }

    itemDiv.appendChild(itemLeft);
    itemDiv.appendChild(itemRight);
    nodeWrapper.appendChild(itemDiv);

    // Apontamento Observation Layout (below tree item)
    if(!isMgmt && !isRootFolder && item.validationStatus === 'Apontamento' && item.observation) {
        const obsBox = document.createElement('div');
        obsBox.className = 'observation-box';
        obsBox.innerHTML = `<strong><i class="ph ph-warning-circle"></i> Observação do Analista:</strong> ${item.observation}`;
        nodeWrapper.appendChild(obsBox);
    }

    const children = getChildItems(item.id);
    if(children.length > 0) {
        const childCont = document.createElement('div');
        childCont.className = 'children-container';
        children.forEach(c => childCont.appendChild(createNode(c, isMgmt)));
        nodeWrapper.appendChild(childCont);
    }

    return nodeWrapper;
}

// Logic implementations
btnAddRoot.addEventListener('click', () => handleAddFolder(null));

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
const btnTogglePendencias = document.getElementById('btn-toggle-pendencias');
const pendenciasMgmtPanel = document.getElementById('pendencias-mgmt-panel');
const btnAddPendencia = document.getElementById('btn-add-pendencia');
const pendenciaStartDateInp = document.getElementById('pendencia-start-date');

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
 
// State for editing pendencies
let editingPendenciaId = null;

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
                // Update existing
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
                // Add new
                curr.pendencias.push({
                    id: generateId(),
                    docName: name,
                    sector: sector,
                    specification: specification,
                    attachments: [],
                    observation: ''
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

if (document.getElementById('new-pendencia-sector')) {
    document.getElementById('new-pendencia-sector').onchange = (e) => {
        const other = document.getElementById('new-pendencia-sector-other');
        if (e.target.value === 'other') {
            other.classList.remove('hidden');
        } else {
            other.classList.add('hidden');
        }
    };
}

function renderPendenciasMgmt() {
    const curr = getCurrentProject();
    const listCont = document.getElementById('pendencias-list-mgmt');
    const sectorSel = document.getElementById('new-pendencia-sector');
    if (!curr || !listCont) return;

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
            <div style="display: flex; gap: 0.5rem;">
                <button class="icon-btn edit" title="Editar Pendência">
                    <i class="ph ph-pencil-simple"></i>
                </button>
                <button class="icon-btn delete" title="Remover Pendência">
                    <i class="ph ph-trash"></i>
                </button>
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

window.handleFileUpload = async function(files, itemId, isPendencia = false) {
    if(!files || files.length === 0) return;
    
    // Dropbox enforcement
    if(!dbx) {
        alert("Atenção: Por favor, conecte a sua conta do Dropbox no painel para anexar documentações ao APF.");
        return;
    }

    const currProject = getCurrentProject();
    if (!currProject) return;

    let targetItem;
    if (isPendencia) {
        targetItem = currProject.pendencias.find(p => p.id === itemId);
    } else {
        targetItem = getItems().find(i => i.id === itemId);
    }
    
    if(targetItem && currProject) {
        const sanitizedProjName = sanitizePathSegment(currProject.name);
        const folderPath = isPendencia ? 'PENDENCIAS' : getItemPath(itemId, true); // Folder for pendencias
        document.body.style.cursor = 'wait';
        
        try {
            if(!targetItem.attachments) targetItem.attachments = [];
            for (const file of Array.from(files)) {
                const id = generateId();
                const sanitizedFileName = file.name.trim();
                const dbxPath = `/APF-Recebimento/${sanitizedProjName}/${folderPath}/${sanitizedFileName}`.replace(/\/+/g, '/');
                
                try {
                    // Upload to Dropbox
                    const response = await dbx.filesUpload({ path: dbxPath, contents: file, mode: 'add', autorename: true });
                    const uploadedPath = response.result.path_display;
                    
                    // Create Shared Link
                    const linkRes = await dbx.sharingCreateSharedLinkWithSettings({ path: uploadedPath });
                    let sharedUrl = linkRes.result.url;
                    
                    targetItem.attachments.push({
                        id: id,
                        name: response.result.name,
                        type: file.type,
                        dropboxPath: uploadedPath,
                        dropboxUrl: sharedUrl,
                        objectUrl: sharedUrl 
                    });
                } catch (err) {
                    console.error("Erro no upload para o Dropbox", err);
                    const errorDetail = err?.error?.error?.summary || err?.status || 'Erro desconhecido';
                    alert(`Falha ao enviar '${file.name}' ao Dropbox. Motivo: ${errorDetail}. Verifique sua conexão ou espaço livre.`);
                }
            }
            saveState();
            renderTree();
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
        
        if (att && att.dropboxPath && dbx) {
            try {
                // Delete from Dropbox
                await dbx.filesDeleteV2({ path: att.dropboxPath });
            } catch (err) {
                console.warn("Aviso: Arquivo já ausente no Dropbox ou token expirado.", err);
            }
        }
        
        targetItem.attachments = targetItem.attachments.filter(a => a.id !== fileId);
        saveState();
        renderTree();
    }
}

// Global modal helpers
window.openPreview = function(fileObj) {
    if (fileObj.dropboxUrl) {
        // Redirect to DBX shared link (which has native file viewing)
        window.open(fileObj.dropboxUrl, '_blank');
        return;
    }

    // Legacy fallback for local files
    document.getElementById('preview-title').textContent = fileObj.name;
    document.getElementById('preview-download-btn').style.display = 'inline-flex';
    document.getElementById('preview-download-btn').href = fileObj.objectUrl;
    document.getElementById('preview-download-btn').download = fileObj.name;
    const body = document.getElementById('preview-body');
    body.innerHTML = '';

    if(fileObj.type.startsWith('image/')){
        body.innerHTML = `<img src="${fileObj.objectUrl}" class="preview-content">`;
    } else if(fileObj.type === 'application/pdf') {
        body.innerHTML = `<iframe src="${fileObj.objectUrl}" class="preview-content"></iframe>`;
    } else {
        body.innerHTML = `<p style="color:var(--text-muted)">Pré-visualização não disponível diretamente no navegador para este formato. Por favor, baixe o arquivo para visualizar.</p>`;
    }
    modalOverlay.classList.remove('hidden');
}

document.getElementById('btn-close-modal').addEventListener('click', () => modalOverlay.classList.add('hidden'));
modalOverlay.addEventListener('click', (e) => { if(e.target === modalOverlay) modalOverlay.classList.add('hidden'); });

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

        const aponHtml = apontamentos > 0
            ? `<div style="margin-top:0.3rem; font-size:0.68rem; color:var(--danger); display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-warning-circle"></i> ${apontamentos} apontamento(s) pendente(s)</div>`
            : '';

        let perfStatus = `No momento, o setor possui <strong>${pct}%</strong> da documentação indexada, o que o classifica com um status <strong>${grade.label}</strong>.`;
        if (pct === 100) perfStatus = `Excelente! O setor atingiu <strong>100%</strong> de entrega da documentação prevista, alcançando padrão <strong>${grade.label}</strong>.`;
        else if (pct < 50) perfStatus = `Atenção: o setor está com baixa adesão de documentos (<strong>${pct}%</strong>), classificado como <strong>${grade.label}</strong>. Recomendamos priorizar estas entregas.`;

        let pendStatus = apontamentos > 0 ? `<br><br><span style="color:var(--danger)"><i class="ph ph-warning-circle"></i> Há <strong>${apontamentos}</strong> documento(s) com apontamentos precisando de correção ou ressubmissão neste setor.</span>` : `<br><br><span style="color:var(--accent)"><i class="ph ph-check-circle"></i> Não há apontamentos bloqueando este setor no momento.</span>`;

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
                    <span style="font-size:0.8rem; font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${root.name}</span>
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
        geminiModelInp.value = localStorage.getItem('apf_gemini_model') || 'gemini-2.5-flash';
        geminiKeyInp.value = localStorage.getItem('apf_gemini_key') || '';
        dbxKeyInp.value = localStorage.getItem('apf_dropbox_app_key') || '';
        apfPassInp.value = localStorage.getItem('apf_access_password') || '';
        settingsModal.classList.remove('hidden');
    });

    btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
    settingsModal.addEventListener('click', (e) => { if(e.target === settingsModal) settingsModal.classList.add('hidden'); });

    btnResetModel.addEventListener('click', () => {
        geminiModelInp.value = 'gemini-2.5-flash';
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
        const dKey = dbxKeyInp.value.trim();
        const aPass = apfPassInp.value.trim();

        if (gModel) localStorage.setItem('apf_gemini_model', gModel);
        if (gKey) localStorage.setItem('apf_gemini_key', gKey); else localStorage.removeItem('apf_gemini_key');
        if (dKey) localStorage.setItem('apf_dropbox_app_key', dKey); else localStorage.removeItem('apf_dropbox_app_key');
        if (aPass) localStorage.setItem('apf_access_password', aPass); else localStorage.removeItem('apf_access_password');

        alert('Configurações salvas com sucesso! Algumas alterações podem exigir o recarregamento da página.');
        settingsModal.classList.add('hidden');
        if (dKey) location.reload(); // Refresh to re-init dropbox with new key
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
            // Fallback to fetch (works for local blobs or direct links)
            let fetchUrl = url;
            if (url.includes('dropbox.com')) {
                fetchUrl = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace(/\?dl=0$/, '').replace(/\?dl=1$/, '');
            }
            
            const response = await fetch(fetchUrl);
            const blob = await response.blob();
            fileDataBase64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
            });
        }

        const apiKey = localStorage.getItem('apf_gemini_key');
        const modelName = localStorage.getItem('apf_gemini_model') || 'gemini-2.5-flash';
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
