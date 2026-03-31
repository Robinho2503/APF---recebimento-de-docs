const fs = require('fs');
let code = fs.readFileSync('c:\\APF---recebimento-de-docs-main\\script.js', 'utf8');

const startStr = 'function createNode(item, isMgmt) {';
// Encontra o fim da função
let startIdx = code.indexOf(startStr);
if (startIdx === -1) {
    console.error("Function start not found");
    process.exit(1);
}

// Find "return nodeWrapper;\n}" after startIdx
let endStr = 'return nodeWrapper;\r\n}';
let endIdx = code.indexOf(endStr, startIdx);

if (endIdx === -1) {
    endStr = 'return nodeWrapper;\n}';
    endIdx = code.indexOf(endStr, startIdx);
}

if (endIdx === -1) {
    console.error("Function end not found");
    process.exit(1);
}

const newCreateNode = `function createNode(item, isMgmt) {
    const nodeWrapper = document.createElement('div');
    nodeWrapper.className = \`tree-node \${item.expanded ? '' : 'collapsed'}\`;

    const hasChildren = getChildItems(item.id).length > 0;
    const isRootFolder = item.parentId === null;

    // The Item div
    const itemDiv = document.createElement('div');
    const baseItemClass = isRootFolder 
        ? "flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 bg-surface-container-low rounded-xl border border-outline-variant/30 relative z-[2] transition-colors hover:bg-surface-container" 
        : "flex flex-col md:flex-row md:items-center justify-between gap-4 p-3 bg-surface-container-lowest rounded-xl border border-outline-variant/15 relative z-[2] transition-colors hover:bg-surface-container-low";
    itemDiv.className = \`tree-item \${baseItemClass}\`;

    const itemLeft = document.createElement('div');
    itemLeft.className = 'item-left flex items-center gap-3 flex-grow flex-wrap';

    const chevron = document.createElement('span');
    chevron.className = 'material-symbols-outlined text-on-surface-variant caret-icon cursor-pointer select-none';
    chevron.textContent = hasChildren ? 'expand_more' : 'chevron_right';
    chevron.style.opacity = hasChildren ? '1' : '0.3';
    chevron.style.fontSize = '1.2rem';

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-primary';
    icon.style.fontSize = isRootFolder ? '1.5rem' : '1.2rem';
    
    if(isRootFolder) {
        let iconName = 'folder_open';
        const n = item.name.toLowerCase();
        if(n.includes('legaliza')) iconName = 'account_balance';
        else if(n.includes('arquit') || n.includes('urbani')) iconName = 'architecture';
        else if(n.includes('engenh')) iconName = 'engineering';
        else if(n.includes('sustent')) iconName = 'eco';
        icon.textContent = iconName;
    } else {
        icon.textContent = (item.attachments && item.attachments.length > 0) ? 'description' : 'folder';
    }
    
    if(item.protected && isMgmt && !isRootFolder) {
        icon.textContent = 'folder_supervised';
        icon.classList.replace('text-primary', 'text-error');
    }

    const nameSpan = document.createElement('div');
    nameSpan.className = 'item-name flex items-center gap-2 font-inter font-semibold text-on-surface cursor-pointer select-none';
    if(isRootFolder) {
        nameSpan.classList.add('root-name');
        nameSpan.style.flex = '0 0 320px';
    }
    
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

    if(isRootFolder && state.currentProjectId !== 'p_default') {
        const stats = getNodeStats(item.id);
        if (stats.pendente > 0) {
            const circle = document.createElement('span');
            circle.className = 'pending-circle bg-error text-on-error w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0';
            circle.textContent = stats.pendente;
            circle.title = \`\${stats.pendente} item(s) pendente(s)\`;
            itemLeft.prepend(circle);
        }
    }

    itemLeft.appendChild(nameSpan);

    const itemRight = document.createElement('div');
    itemRight.className = 'item-right flex flex-col items-end gap-2 w-full md:w-auto mt-2 md:mt-0';

    if(!isMgmt) {
        if(!isRootFolder) {
            const hasAtt = item.attachments && item.attachments.length > 0;
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.className = 'file-input-hidden';
            fileInput.multiple = true;
            fileInput.onchange = (e) => handleFileUpload(e.target.files, item.id);
            itemRight.appendChild(fileInput);

            const statusRow = document.createElement('div');
            statusRow.className = 'item-status-row flex items-center justify-end w-full gap-3';

            const badgesWrap = document.createElement('div');
            badgesWrap.className = 'flex flex-wrap items-center gap-1.5';

            const statusBadge = document.createElement('span');
            statusBadge.className = hasAtt ? 'px-2 pl-1.5 py-0.5 rounded-full bg-green-50/50 text-green-700 border border-green-200/50 text-[10px] font-bold uppercase flex items-center gap-1' : 'px-2 pl-1.5 py-0.5 rounded-full bg-red-50/50 text-red-700 border border-red-200/50 text-[10px] font-bold uppercase flex items-center gap-1';
            statusBadge.innerHTML = hasAtt ? '<span class="material-symbols-outlined text-[12px]">check_circle</span> Entregue' : '<span class="material-symbols-outlined text-[12px]">pending</span> Pendente';
            badgesWrap.appendChild(statusBadge);

            if(hasAtt && item.validationStatus) {
                const valBadge = document.createElement('span');
                if(item.validationStatus === 'Validado') valBadge.className = 'px-2 pl-1.5 py-0.5 rounded-full bg-blue-50/50 text-blue-700 border border-blue-200/50 text-[10px] font-bold uppercase flex items-center gap-1';
                else if(item.validationStatus === 'Apontamento') valBadge.className = 'px-2 pl-1.5 py-0.5 rounded-full bg-orange-50/50 text-orange-700 border border-orange-200/50 text-[10px] font-bold uppercase flex items-center gap-1';
                else valBadge.className = 'px-2 pl-1.5 py-0.5 rounded-full bg-yellow-50/50 text-yellow-700 border border-yellow-200/50 text-[10px] font-bold uppercase flex items-center gap-1';
                
                const valIconMap = {'Validado': 'verified', 'Apontamento': 'warning', 'Em Análise de APF': 'search'};
                const mappedIcon = valIconMap[item.validationStatus] || 'info';
                
                valBadge.innerHTML = \`<span class="material-symbols-outlined text-[12px]">\${mappedIcon}</span> \${item.validationStatus}\`;
                badgesWrap.appendChild(valBadge);
            }

            statusRow.appendChild(badgesWrap);

            const btnAttach = document.createElement('button');
            btnAttach.className = 'flex items-center justify-center w-8 h-8 rounded-md bg-surface-container text-on-surface hover:bg-surface-container-high hover:text-primary transition-all shadow-sm';
            btnAttach.title = 'Anexar documento';
            btnAttach.innerHTML = '<span class="material-symbols-outlined text-[18px]">attach_file</span>';
            btnAttach.onclick = () => fileInput.click();
            statusRow.appendChild(btnAttach);

            itemRight.appendChild(statusRow);

            if(hasAtt) {
                const inlineAttachments = document.createElement('div');
                inlineAttachments.className = 'inline-attachments-row w-full flex flex-wrap justify-end gap-1.5 mt-2';
                
                item.attachments.forEach(att => {
                    const attBadge = document.createElement('div');
                    attBadge.className = 'inline-attachment flex items-center gap-1 bg-surface-container-high px-2 py-1 rounded-full text-[10px] border border-outline-variant/20 shadow-sm';
                    
                    const nameTxt = document.createElement('span');
                    nameTxt.className = 'text-truncate font-medium text-on-surface-variant max-w-[140px] truncate ml-1';
                    nameTxt.title = att.name;
                    nameTxt.textContent = att.name;

                    const btnAi = document.createElement('button');
                    btnAi.className = 'flex items-center justify-center w-5 h-5 text-primary hover:text-primary-dim transition-colors';
                    btnAi.title = 'Extrair leitura do doc com IA';
                    btnAi.innerHTML = '<span class="material-symbols-outlined text-[14px]">neurology</span>';
                    btnAi.onclick = () => window.analyzeDocumentAI(att);

                    const btnView = document.createElement('button');
                    btnView.className = 'flex items-center justify-center w-5 h-5 text-on-surface-variant hover:text-primary transition-colors';
                    btnView.title = 'Visualizar';
                    btnView.innerHTML = '<span class="material-symbols-outlined text-[14px]">visibility</span>';
                    btnView.onclick = () => window.openPreview(att);
                    
                    const btnDown = document.createElement('a');
                    btnDown.className = 'flex items-center justify-center w-5 h-5 text-on-surface-variant hover:text-primary transition-colors';
                    btnDown.title = 'Baixar';
                    btnDown.download = att.name;
                    btnDown.href = att.objectUrl;
                    btnDown.innerHTML = '<span class="material-symbols-outlined text-[14px]">download</span>';
                    
                    const btnDel = document.createElement('button');
                    btnDel.className = 'flex items-center justify-center w-5 h-5 text-on-surface-variant hover:text-error transition-colors mr-1';
                    btnDel.title = 'Remover';
                    btnDel.innerHTML = '<span class="material-symbols-outlined text-[14px]">close</span>';
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
                const pendingBar = document.createElement('div');
                pendingBar.className = 'pending-action-bar w-full flex flex-col gap-2 mt-2 pt-2 border-t border-dashed border-outline-variant/30';
                
                const pendingRow = document.createElement('div');
                pendingRow.className = 'pending-action-row w-full flex flex-wrap gap-2 items-center justify-end';

                const forecastGroup = document.createElement('div');
                forecastGroup.className = 'flex items-center gap-1.5';

                const forecastLabel = document.createElement('label');
                forecastLabel.className = 'text-[10px] font-semibold text-on-surface-variant';
                forecastLabel.textContent = 'Previsão:';

                const forecastInput = document.createElement('input');
                forecastInput.type = 'date';
                forecastInput.className = 'px-2 py-1.5 text-[10px] bg-surface-container rounded border border-outline-variant/20 focus:outline-none focus:ring-1 focus:ring-primary w-[110px] text-on-surface shadow-sm';
                if(item.forecastDate) forecastInput.value = item.forecastDate;

                forecastInput.onchange = (e) => {
                    item.forecastDate = e.target.value;
                    saveState();
                };

                forecastGroup.appendChild(forecastLabel);
                forecastGroup.appendChild(forecastInput);

                const btnJustify = document.createElement('button');
                btnJustify.className = 'px-2 py-1.5 text-[10px] flex items-center gap-1 font-semibold rounded border border-outline-variant/30 text-on-surface-variant hover:bg-surface-container-high transition-all shadow-sm';
                btnJustify.innerHTML = '<span class="material-symbols-outlined text-[12px]">chat</span> Justificar';
                
                pendingRow.appendChild(forecastGroup);
                pendingRow.appendChild(btnJustify);
                pendingBar.appendChild(pendingRow);

                const justBox = document.createElement('div');
                justBox.className = 'justification-box w-full hidden mt-1';
                
                const justInput = document.createElement('textarea');
                justInput.className = 'w-full p-2 text-xs bg-surface-container rounded border border-outline-variant/20 focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px] resize-y text-on-surface placeholder:text-on-surface-variant/50';
                justInput.placeholder = 'Escreva a justificativa para a pendência...';
                if(item.justification) justInput.value = item.justification;

                justInput.onchange = (e) => {
                    item.justification = e.target.value;
                    saveState();
                };

                justBox.appendChild(justInput);
                pendingBar.appendChild(justBox);

                if(item.justification && item.justification.trim() !== '') {
                    btnJustify.classList.replace('border-outline-variant/30', 'border-primary/50');
                    btnJustify.classList.replace('text-on-surface-variant', 'text-primary');
                }

                btnJustify.onclick = () => {
                    justBox.classList.toggle('hidden');
                };

                itemRight.appendChild(pendingBar);
            }
            
            itemDiv.addEventListener('dragover', (e) => { e.preventDefault(); itemDiv.classList.add('drag-over'); });
            itemDiv.addEventListener('dragleave', (e) => { itemDiv.classList.remove('drag-over'); });
            itemDiv.addEventListener('drop', (e) => {
                e.preventDefault(); itemDiv.classList.remove('drag-over');
                if(e.dataTransfer.files && e.dataTransfer.files.length > 0) handleFileUpload(e.dataTransfer.files, item.id);
            });
        }
    } else {
        if(!isRootFolder) {
            const mgmtFields = document.createElement('div');
            mgmtFields.className = 'management-fields flex flex-wrap gap-2 items-center justify-end w-full';
            
            if (item.attachments && item.attachments.length > 0) {
                const valSelect = document.createElement('select');
                valSelect.className = 'px-2 py-1.5 text-[11px] font-semibold bg-surface border border-outline-variant/30 rounded shadow-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary max-w-[140px]';
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
                    obsInp.className = 'px-2 py-1.5 text-[11px] bg-surface border border-outline-variant/30 rounded shadow-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary flex-1 min-w-[160px]';
                    obsInp.placeholder = 'Qual apontamento?';
                    obsInp.value = item.observation || '';
                    obsInp.oninput = (e) => { item.observation = e.target.value; saveState(); }; 
                    obsInp.onblur = () => renderTree();
                    mgmtFields.appendChild(obsInp);
                }
            } else {
                mgmtFields.innerHTML = '<span class="text-[10px] text-on-surface-variant italic px-2 py-1 border border-dashed border-outline-variant/30 rounded-md">Aguardando doc</span>';
            }
            itemRight.appendChild(mgmtFields);
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'flex items-center gap-1.5 justify-end mt-2 md:mt-0';

        const btnAddSub = document.createElement('button');
        btnAddSub.className = 'px-2 py-1 bg-surface-container hover:bg-surface-container-high border border-outline-variant/15 text-on-surface rounded shadow-sm flex items-center gap-1 text-[10px] font-semibold transition-colors';
        btnAddSub.title = 'Nova Subpasta';
        btnAddSub.innerHTML = '<span class="material-symbols-outlined text-[14px]">create_new_folder</span> Subpasta';
        btnAddSub.onclick = () => handleAddFolder(item.id);
        actionsDiv.appendChild(btnAddSub);

        const btnRename = document.createElement('button');
        btnRename.className = 'w-7 h-7 flex items-center justify-center rounded shadow-sm border border-outline-variant/15 bg-surface-container hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors';
        btnRename.title = 'Renomear';
        btnRename.innerHTML = '<span class="material-symbols-outlined text-[14px]">edit</span>';
        btnRename.onclick = () => handleRenameFolder(item.id);
        actionsDiv.appendChild(btnRename);

        const btnDel = document.createElement('button');
        btnDel.className = 'w-7 h-7 flex items-center justify-center rounded shadow-sm border border-outline-variant/15 bg-surface-container hover:bg-red-50 text-on-surface-variant hover:text-error transition-colors';
        btnDel.title = 'Excluir';
        btnDel.innerHTML = '<span class="material-symbols-outlined text-[14px]">delete</span>';
        btnDel.onclick = () => handleDeleteFolder(item.id);
        actionsDiv.appendChild(btnDel);

        itemRight.appendChild(actionsDiv);

        if(!isRootFolder && item.attachments && item.attachments.length > 0) {
            const inlineAttachments = document.createElement('div');
            inlineAttachments.className = 'flex flex-wrap gap-1.5 justify-end mt-3 w-full';
            
            item.attachments.forEach(att => {
                const attBadge = document.createElement('div');
                attBadge.className = 'inline-attachment flex items-center gap-1 bg-surface-container-high px-2 py-1 rounded-full text-[10px] border border-outline-variant/20 shadow-sm';
                
                const nameTxt = document.createElement('span');
                nameTxt.className = 'text-truncate font-medium text-on-surface-variant max-w-[120px] truncate ml-1';
                nameTxt.title = att.name;
                nameTxt.textContent = att.name;

                const btnView = document.createElement('button');
                btnView.className = 'flex items-center justify-center w-5 h-5 text-on-surface-variant hover:text-primary transition-colors';
                btnView.title = 'Visualizar';
                btnView.innerHTML = '<span class="material-symbols-outlined text-[14px]">visibility</span>';
                btnView.onclick = () => window.openPreview(att);
                
                const btnAi = document.createElement('button');
                btnAi.className = 'flex items-center justify-center w-5 h-5 text-primary hover:text-primary-dim transition-colors';
                btnAi.title = "Extrair leitura do doc com IA";
                btnAi.innerHTML = '<span class="material-symbols-outlined text-[14px]">neurology</span>';
                btnAi.onclick = () => window.analyzeDocumentAI(att);

                const btnDown = document.createElement('a');
                btnDown.className = 'flex items-center justify-center w-5 h-5 text-on-surface-variant hover:text-primary transition-colors';
                btnDown.title = 'Baixar';
                btnDown.download = att.name;
                btnDown.href = att.objectUrl;
                btnDown.innerHTML = '<span class="material-symbols-outlined text-[14px]">download</span>';
                
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

    if(!isMgmt && !isRootFolder && item.validationStatus === 'Apontamento' && item.observation) {
        const obsBox = document.createElement('div');
        obsBox.className = 'observation-box bg-orange-50/50 border-l-4 border-orange-500 text-orange-800 text-[11px] p-2 ml-8 mt-1 rounded-r shadow-sm';
        obsBox.innerHTML = \`<span class="material-symbols-outlined text-[12px] align-text-bottom mr-1 text-orange-600">warning</span> <strong>Apontamento:</strong> \${item.observation}\`;
        nodeWrapper.appendChild(obsBox);
    }

    const children = getChildItems(item.id);
    if(children.length > 0) {
        const childCont = document.createElement('div');
        childCont.className = 'children-container ml-6 pl-3 mt-2 border-l border-dashed border-outline-variant/40 flex flex-col gap-2';
        children.forEach(c => childCont.appendChild(createNode(c, isMgmt)));
        nodeWrapper.appendChild(childCont);
    }

    return nodeWrapper;
}`;

code = code.substring(0, startIdx) + newCreateNode + code.substring(endIdx + endStr.length);
fs.writeFileSync('c:\\APF---recebimento-de-docs-main\\script.js', code);
console.log("Success");
