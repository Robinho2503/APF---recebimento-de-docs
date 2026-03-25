// Data Models & State Initialization
const DEFAULT_ITEMS = [
    { id: 'sec1', name: 'Legalização', parentId: null, protected: true, expanded: true, attachments: [] },
    { id: 'sec2', name: 'Arquitetura e Urbanismo', parentId: null, protected: true, expanded: true, attachments: [] },
    { id: 'sec3', name: 'Engenharia', parentId: null, protected: true, expanded: true, attachments: [] },
    { id: 'sec4', name: 'Sustentabilidade', parentId: null, protected: true, expanded: true, attachments: [] }
];

let state = {
    projects: [
        { id: 'p_default', name: 'Modelo de Entrega', items: JSON.parse(JSON.stringify(DEFAULT_ITEMS)), dueDate: '', createdAt: new Date().toISOString().split('T')[0] }
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
function loadState() {
    const saved = localStorage.getItem('apf_checklist_v2.2');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            parsed.projects.forEach(p => {
                p.items.forEach(i => i.attachments = []);
                if(!p.createdAt) p.createdAt = new Date().toISOString().split('T')[0];
            });
            state = parsed;
            
            const defP = state.projects.find(p => p.id === 'p_default');
            if(defP && defP.name === 'Empreendimento Base') defP.name = 'Modelo de Entrega';

            if(!state.projects.find(p => p.id === state.currentProjectId)) {
                state.currentProjectId = state.projects[0].id;
            }
        } catch(e) { console.error('Error loading state', e); }
    }
}

function saveState() {
    const saveableState = {
        projects: state.projects.map(p => ({
            ...p,
            items: p.items.map(item => ({...item, attachments: []}))
        })),
        currentProjectId: state.currentProjectId
    };
    localStorage.setItem('apf_checklist_v2.2', JSON.stringify(saveableState));
}

// DOM Elements
const projectSelect = document.getElementById('project-select');
const btnNewProject = document.getElementById('btn-new-project');
const btnDeleteProject = document.getElementById('btn-delete-project');

const checklistContainer = document.getElementById('checklist-render-area');
const managementContainer = document.getElementById('management-render-area');
const trackingContainer = document.getElementById('tracking-render-area');

const tabs = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

const passwordLock = document.getElementById('password-lock');
const managementContent = document.getElementById('management-content');
const inputPassword = document.getElementById('apf-password');
const btnUnlock = document.getElementById('btn-unlock');
const passwordError = document.getElementById('password-error');

const btnAddRoot = document.getElementById('btn-add-root');
const currentProjectName = document.getElementById('current-project-name');
const projectDueDateInp = document.getElementById('project-due-date');
const projectGlobalCountdown = document.getElementById('project-global-countdown');

const modalOverlay = document.getElementById('preview-modal');

// Init
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    updateProjectDropdown();
    updateGlobalDateUI();
    renderTree();
    renderTracking();
    initAIEngine();
});

// Authentication
btnUnlock.addEventListener('click', () => {
    if(inputPassword.value === '1234') {
        isAuthenticated = true;
        inputPassword.value = '';
        passwordError.style.display = 'none';
        applyAuthState();
    } else {
        passwordError.style.display = 'block';
    }
});
function applyAuthState() {
    if(isAuthenticated) {
        passwordLock.style.display = 'none';
        managementContent.style.display = 'block';
    } else {
        passwordLock.style.display = 'block';
        managementContent.style.display = 'none';
    }
}

// Tabs Navigation
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
        
        updateProjectDropdown();
        updateGlobalDateUI();
        renderTree();
        
        if(tab.dataset.tab === 'tracking') renderTracking();
    });
});

// Project Management & Global UI
function updateGlobalDateUI() {
    const curr = getCurrentProject();
    if(!curr || curr.id === 'none' || (!isMgmtActive() && curr.id === 'p_default')) {
        document.getElementById('checklist-proj-name').textContent = '';
        projectGlobalCountdown.style.display = 'none';
        projectDueDateInp.value = '';
        return;
    }
    
    document.getElementById('checklist-proj-name').textContent = curr.name;
    projectDueDateInp.value = curr.dueDate || '';
    
    if(curr.dueDate) {
        const diff = calculateDays(curr.dueDate);
        let diffText = ''; let dClass = '';
        if(diff === 0) { diffText = '(Hoje)'; dClass='good'; }
        else if(diff > 0) { diffText = `(Falta(m) ${diff} dia(s))`; dClass='good'; }
        else { diffText = `(Atrasado ${Math.abs(diff)} dia(s))`; dClass='late'; }
        
        projectGlobalCountdown.style.display = 'block';
        projectGlobalCountdown.innerHTML = `<span class="date-label">Data de Entrega Final: <strong style="color:var(--text-main)">${formatDateToPT(curr.dueDate)}</strong></span><br><span class="date-countdown ${dClass}" style="font-size: 0.95rem;">${diffText}</span>`;
    } else {
        projectGlobalCountdown.style.display = 'none';
    }
}

projectDueDateInp.addEventListener('change', (e) => {
    const curr = getCurrentProject();
    if(curr) {
        curr.dueDate = e.target.value;
        saveState();
        updateGlobalDateUI();
        renderTracking();
    }
});

function updateProjectDropdown() {
    const mgmt = isMgmtActive();
    projectSelect.innerHTML = '';
    
    let visibleProjects = state.projects;
    
    if (!mgmt) {
        visibleProjects = state.projects.filter(p => p.id !== 'p_default');
        
        const defOpt = document.createElement('option');
        defOpt.value = 'none';
        defOpt.textContent = visibleProjects.length === 0 ? '-- Crie um Empreendimento no Acesso APF --' : '-- Selecionar Empreendimento --';
        projectSelect.appendChild(defOpt);
    }
    
    visibleProjects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        projectSelect.appendChild(opt);
    });

    if (mgmt) {
        projectSelect.value = state.currentProjectId;
    } else {
        if (state.currentProjectId === 'p_default') {
            projectSelect.value = 'none';
        } else {
            projectSelect.value = state.currentProjectId || 'none';
        }
    }

    btnDeleteProject.style.display = state.projects.length > 1 ? 'inline-flex' : 'none';
    
    const curr = getCurrentProject();
    if(curr && curr.id !== 'none' && (mgmt || curr.id !== 'p_default')) {
        currentProjectName.textContent = curr.name;
    } else {
        currentProjectName.textContent = '';
    }
}

projectSelect.addEventListener('change', (e) => {
    state.currentProjectId = e.target.value;
    saveState();
    updateProjectDropdown();
    updateGlobalDateUI();
    renderTree();
});

btnNewProject.addEventListener('click', () => {
    const name = prompt('Nome do novo empreendimento (que herdará as pastas do Modelo de Entrega):');
    if(name && name.trim()){
        const baseProj = state.projects.find(p => p.id === 'p_default') || state.projects[0];
        
        const duplicatedItems = JSON.parse(JSON.stringify(baseProj.items)).map(item => {
            item.attachments = [];
            item.validationStatus = 'Em Análise';
            item.observation = '';
            item.expanded = true;
            return item;
        });

        const newProj = {
            id: 'p_' + generateId(),
            name: name.trim(),
            dueDate: '',
            createdAt: new Date().toISOString().split('T')[0],
            items: duplicatedItems
        };
        state.projects.push(newProj);
        state.currentProjectId = newProj.id;
        saveState();
        updateProjectDropdown();
        updateGlobalDateUI();
        renderTree();
        renderTracking();
    }
});

btnDeleteProject.addEventListener('click', () => {
    if(confirm('Atenção: Tem certeza que deseja excluir ESTE empreendimento completamente?')){
        state.projects = state.projects.filter(p => p.id !== state.currentProjectId);
        state.currentProjectId = state.projects[0].id; // fallback
        saveState();
        updateProjectDropdown();
        updateGlobalDateUI();
        renderTree();
        renderTracking();
    }
});

// Tracker Render
function renderTracking() {
    trackingContainer.innerHTML = '';
    const trackableProjects = state.projects.filter(p => p.id !== 'p_default');
    
    if(trackableProjects.length === 0) {
        trackingContainer.innerHTML = '<p style="color:var(--text-muted); padding: 1rem; border: 1px dashed rgba(255,255,255,0.1); border-radius:0.5rem;"><i class="ph ph-warning"></i> Nenhum empreendimento ativo criado ainda. Primeiramente, crie no Acesso APF.</p>';
        return;
    }

    trackableProjects.forEach(p => {
        const card = document.createElement('div');
        card.className = 'tracking-card';
        
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

        card.innerHTML = `
            <div class="tracking-left">
                <div class="tk-status" style="color: ${textCol}">${prazoText}</div>
                <div class="tk-date"><i class="ph ph-calendar"></i> Prazo: ${dateDesc}</div>
            </div>
            <div class="tracking-body">
                <h3><i class="ph ph-buildings text-primary"></i> ${p.name}</h3>
                <div class="tk-progress-bg">
                    <div class="tk-progress-fill" style="width: ${progressPct}%; background: ${barColor};"></div>
                </div>
                <div class="tk-labels">
                    <span>Início: ${formatDateToPT(p.createdAt) || '--/--/----'}</span>
                    <span>Fim: ${p.dueDate ? dateDesc : '--/--/----'}</span>
                </div>
            </div>
        `;
        trackingContainer.appendChild(card);
    });
}

// Rendering Tree Helpers
function getChildItems(parentId) {
    return getItems().filter(item => item.parentId === parentId);
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
    
    if (!mgmt && (!currProj || currProj.id === 'none' || currProj.id === 'p_default')) {
        let msg = '<i class="ph ph-warning"></i> Selecione um Empreendimento acima para visualizar a documentação.';
        if(state.projects.length <= 1) msg = '<i class="ph ph-warning"></i> Você precisa criar um Empreendimento novo na aba "Acesso APF" para manipular os checklists.';
        checklistContainer.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding: 3rem 1rem; border: 1px dashed var(--panel-border); border-radius: 0.5rem;">${msg}</div>`;
        return;
    }

    const rootItems = getChildItems(null);
    rootItems.forEach(item => {
        checklistContainer.appendChild(createNode(item, false));
        managementContainer.appendChild(createNode(item, true));
    });
}

function calculateDays(dueDate) {
    if(!dueDate) return null;
    const now = new Date();
    const due = new Date(dueDate);
    now.setHours(0,0,0,0); due.setHours(0,0,0,0);
    const diffTime = due - now;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
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
    if(isRootFolder) icon.className = 'ph ph-folder-notch-open item-icon';
    else icon.className = (item.attachments && item.attachments.length > 0) ? 'ph ph-file-text item-icon' : 'ph ph-folder item-icon';
    if(item.protected && isMgmt) icon.className = 'ph ph-folder-lock item-icon';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    if(isRootFolder) nameSpan.classList.add('root-name'); // Adds flex column behavior
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
    itemLeft.appendChild(nameSpan);

    // ROOT FOLDER STATS in itemLeft for column layout
    if(isRootFolder) {
        const stats = getNodeStats(item.id);
        const statsSpan = document.createElement('div');
        statsSpan.className = 'root-stats-column';
        
        if (stats.pendente > 0) {
            const pBadge = document.createElement('span');
            pBadge.className = 'badge badge-pendente';
            pBadge.innerHTML = `<i class="ph ph-clock"></i> ${stats.pendente} Pendente(s)`;
            statsSpan.appendChild(pBadge);
        } else if (getChildItems(item.id).length > 0) {
            const okBadge = document.createElement('span');
            okBadge.className = 'badge badge-entregue';
            okBadge.innerHTML = `<i class="ph ph-check-circle"></i> Tudo Entregue`;
            statsSpan.appendChild(okBadge);
        }
        
        if (stats.apontamento > 0) {
            const aBadge = document.createElement('span');
            aBadge.className = 'badge badge-apontamento';
            aBadge.innerHTML = `<i class="ph ph-warning-circle"></i> ${stats.apontamento} Apontamento(s)`;
            statsSpan.appendChild(aBadge);
        }
        
        itemLeft.appendChild(statsSpan);
    }

    const itemRight = document.createElement('div');
    itemRight.className = 'item-right';

    if(!isMgmt) {
        // --- VISÃO GERAL ---
        if(!isRootFolder) {
            const statusBadge = document.createElement('span');
            const hasAtt = item.attachments && item.attachments.length > 0;
            statusBadge.className = hasAtt ? 'badge badge-entregue' : 'badge badge-pendente';
            statusBadge.textContent = hasAtt ? 'Entregue' : 'Pendente';
            itemRight.appendChild(statusBadge);

            if(item.validationStatus) {
                const valBadge = document.createElement('span');
                if(item.validationStatus === 'Validado') valBadge.className = 'badge badge-validado';
                else if(item.validationStatus === 'Apontamento') valBadge.className = 'badge badge-apontamento';
                else valBadge.className = 'badge badge-analise';
                valBadge.textContent = item.validationStatus;
                itemRight.appendChild(valBadge);
            }

            // Inline Attachments rendering inside itemRight
            if(item.attachments && item.attachments.length > 0) {
                const inlineAttachments = document.createElement('div');
                inlineAttachments.style.display = 'flex';
                inlineAttachments.style.gap = '0.5rem';
                inlineAttachments.style.flexWrap = 'wrap';
                
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
                    btnAi.title = "Extrair leitura do doc com IA";
                    btnAi.innerHTML = '<i class="ph ph-magic-wand text-primary"></i>';
                    btnAi.onclick = () => window.analyzeDocumentAI(att.objectUrl, att.type, att.name);

                    const btnView = document.createElement('button');
                    btnView.className = 'icon-btn';
                    btnView.innerHTML = '<i class="ph ph-eye"></i>';
                    btnView.onclick = () => window.openPreview(att);
                    
                    const btnDown = document.createElement('a');
                    btnDown.className = 'icon-btn';
                    btnDown.download = att.name;
                    btnDown.href = att.objectUrl;
                    btnDown.innerHTML = '<i class="ph ph-download-simple"></i>';
                    
                    const btnDel = document.createElement('button');
                    btnDel.className = 'icon-btn delete';
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
            }

            // Anexar Button
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.className = 'file-input-hidden';
            fileInput.multiple = true;
            fileInput.onchange = (e) => handleFileUpload(e.target.files, item.id);

            const btnAttach = document.createElement('button');
            btnAttach.className = 'btn btn-outline btn-sm';
            btnAttach.innerHTML = '<i class="ph ph-paperclip"></i> Anexar';
            btnAttach.onclick = () => fileInput.click();
            
            itemRight.appendChild(fileInput);
            itemRight.appendChild(btnAttach);
            
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
            
            const valSelect = document.createElement('select');
            valSelect.className = 'input-modern btn-sm';
            valSelect.title = 'Status de Validação';
            ['Em Análise', 'Validado', 'Apontamento'].forEach(opt => {
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
            itemRight.appendChild(mgmtFields);
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex'; actionsDiv.style.gap = '0.5rem';

        const btnAddSub = document.createElement('button');
        btnAddSub.className = 'btn btn-outline btn-sm';
        btnAddSub.innerHTML = '<i class="ph ph-folder-plus"></i> <span style="margin-left:5px">Subpasta</span>';
        btnAddSub.onclick = () => handleAddFolder(item.id);
        actionsDiv.appendChild(btnAddSub);

        if(!item.protected) {
            const btnDel = document.createElement('button');
            btnDel.className = 'icon-btn delete';
            btnDel.innerHTML = '<i class="ph ph-trash"></i>';
            btnDel.onclick = () => handleDeleteFolder(item.id);
            actionsDiv.appendChild(btnDel);
        }
        itemRight.appendChild(actionsDiv);
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
            expanded: true,
            attachments: [],
            validationStatus: 'Em Análise',
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

window.handleFileUpload = function(files, itemId) {
    if(!files || files.length === 0) return;
    const targetItem = getItems().find(i => i.id === itemId);
    if(targetItem) {
        if(!targetItem.attachments) targetItem.attachments = [];
        Array.from(files).forEach(file => {
            targetItem.attachments.push({
                id: generateId(),
                name: file.name,
                type: file.type,
                objectUrl: URL.createObjectURL(file)
            });
        });
        renderTree();
    }
}

window.handleDeleteFile = function(itemId, fileId) {
    const targetItem = getItems().find(i => i.id === itemId);
    if(targetItem && targetItem.attachments){
        targetItem.attachments = targetItem.attachments.filter(a => a.id !== fileId);
        renderTree();
    }
}

// Global modal helpers
window.openPreview = function(fileObj) {
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
    const btnGenerateAi = document.getElementById('btn-generate-ai');
    if (!btnGenerateAi) return;

    btnGenerateAi.addEventListener('click', async () => {
        const out = document.getElementById('ai-report-output');
        const load = document.getElementById('ai-loading');
        
        out.style.display = 'none';
        load.style.display = 'block';
        btnGenerateAi.disabled = true;

        let reportData = [];
        const nonBase = state.projects.filter(p => p.id !== 'p_default');
        
        if (nonBase.length === 0) {
            load.style.display = 'none';
            out.style.display = 'block';
            out.innerHTML = '<span style="color:var(--warning)">Não há empreendimentos estruturados suficientes para análise.</span>';
            btnGenerateAi.disabled = false;
            return;
        }

        nonBase.forEach(p => {
            let pInfo = `Nome: ${p.name} | Data Alvo (Deadline): ${p.dueDate || 'Nenhuma'}\n`;
            let delayDays = p.dueDate ? calculateDays(p.dueDate) : null;
            pInfo += `Status Temporal Crítico: ${delayDays !== null ? (delayDays < 0 ? 'ATRASADO, operação estourou prazos em ' + Math.abs(delayDays) + ' dias' : 'No prazo de segurança, sobram ' + delayDays + ' dias limite') : 'Sem Prazo'}\n`;
            
            pInfo += "Status Estatístico por Setor da Equipe:\n";
            const roots = p.items.filter(i => i.parentId === null);
            roots.forEach(root => {
                let pend = 0; let apon = 0; let entr = 0;
                const processNode = (itemId) => {
                    const item = p.items.find(i => i.id === itemId);
                    if(item && item.parentId !== null) {
                        if(!item.attachments || item.attachments.length === 0) pend++; else entr++;
                        if(item.validationStatus === 'Apontamento') apon++;
                    }
                    p.items.filter(i => i.parentId === itemId).forEach(c => processNode(c.id));
                };
                processNode(root.id);
                pInfo += ` - [${root.name}]: Ok Anexados (${entr}) | Travados/Atrasados (${pend}) | Erros/Apontamentos (${apon})\n`;
            });
            reportData.push(pInfo);
        });

        const systemPrompt = "Aja profissionalmente como um Consultor Gestor de Operações Sênior.\n" +
            "Seu trabalho é consumir este relatório operacional e expor soluções baseadas nessa lógica.\n" +
            "1. Dê um panorama de quais documentos mais atrasam ou quais projetos correm mais riscos de falhar.\n" +
            "2. Apresente quais Setores/Áreas da empresa entregam a burocracia de forma mais eficaz e cite os que seguram o avanço (como gargalos estruturais e falhas de prazo).\n" +
            "3. Aponte resoluções (checklist prático em tópicos) que ataquem diretamente os grandes pontos críticos.\n" +
            "Utilize markdown (headers, asteriscos, itálicos) e pontue os nomes das áreas e projetos sem muita ladainha genérica.\n\n" +
            "DADOS ORGÂNICOS DESSA SESSÃO:\n\n" + reportData.join('\n\n');

        try {
            let apiKey = localStorage.getItem('apf_gemini_key');
            if(!apiKey) {
                apiKey = prompt("Google Gemini API Key não encontrada no seu navegador.\n\nPor motivos de segurança (o repositório é público no GitHub), a chave antiga foi revogada automaticamente pelo Google.\nPor favor, crie uma chave gratuita no site Google AI Studio e cole aqui:");
                if(!apiKey) throw new Error("API Key não fornecida.");
                localStorage.setItem('apf_gemini_key', apiKey);
            }
            const aiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;
            
            const aiRes = await fetch(aiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt }] }] })
            });

            if(!aiRes.ok) {
                localStorage.removeItem('apf_gemini_key');
                throw new Error('A chave de API foi rejeitada pelo Google. Ela foi removida do sistema; tente novamente com uma chave válida.');
            }
            const data = await aiRes.json();
            const textOut = data.candidates[0].content.parts[0].text;
            
            const formattedHtml = textOut.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--primary);">$1</strong>').replace(/\*(.*?)\*/g, '<em style="opacity: 0.8">$1</em>').replace(/\n/g, '<br>');
            load.style.display = 'none';
            out.style.display = 'block';
            out.innerHTML = formattedHtml;
        } catch(e) {
            console.error(e);
            load.style.display = 'none';
            out.style.display = 'block';
            out.innerHTML = `<span style="color:var(--danger)">Erro Crítico ao processar IA: A chave de API do Gemini fornecida falhou. Verifique conexão, formato da chave, e cotas locais. Detalhe técnico: ${e.message}</span>`;
        } finally {
            btnGenerateAi.disabled = false;
        }
    });
}

window.analyzeDocumentAI = async function(url, mimeType, name) {
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
        const response = await fetch(url);
        const blob = await response.blob();
        
        const base64data = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
        });

        let apiKey = localStorage.getItem('apf_gemini_key');
        if(!apiKey) {
            apiKey = prompt("Google Gemini API Key não encontrada no seu navegador.\n\nPor favor, insira sua chave do Google AI Studio:");
            if(!apiKey) throw new Error("API Key não fornecida.");
            localStorage.setItem('apf_gemini_key', apiKey);
        }
        const aiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;
        
        if(!['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'].includes(mimeType)) {
            body.innerHTML = `<div style="padding: 2rem; color: var(--danger)"><i class="ph ph-warning" style="font-size: 2rem"></i><br>A extração visual Multimodal do Gemini 1.5 suporta especificamente leitura de imagens PDF nativas, JPG e PNG. O arquivo entregue apresenta extensão que o motor não compreende.</div>`;
            return;
        }

        const payload = {
            contents: [{
                parts: [
                    { text: "Verifique ou extraia um resumo inteligente deste documento/planta anexado sendo preciso e cirúrgico. Quais os pontos ou dados principais que você identifica listados nele?" },
                    { inline_data: { mime_type: mimeType, data: base64data } }
                ]
            }]
        };

        const aiRes = await fetch(aiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if(!aiRes.ok) {
            localStorage.removeItem('apf_gemini_key');
            throw new Error('A Key API Gemini foi bloqueada na requisição. Chave removida.');
        }
        const data = await aiRes.json();
        const textOut = data.candidates[0].content.parts[0].text;
        
        const formattedHtml = textOut.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--accent);">$1</strong>').replace(/\n/g, '<br>');

        body.innerHTML = `<div style="text-align:left; color:white; font-size:0.95rem; line-height:1.6; padding: 1rem; width: 100%; white-space: break-spaces;">${formattedHtml}</div>`;
        
    } catch(e) {
        console.error(e);
        body.innerHTML = `<p style="color:var(--danger); padding:2rem;">Ocorreu uma falha interativa ao repassar a imagem local para o Endpoint Google. Nota Privada: Como os arquivos não são armazenados em nuvem, arquivos da sessão antiga do navegador expiram na memória local (Blob Dead). Faça o upload novamente na aba em tempo real e clique na vara de condão mágica.</p>`;
    }
}
