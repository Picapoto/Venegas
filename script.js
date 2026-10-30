// script.js
const STORAGE_KEY = 'financial_dashboard_multifund_v1';
const IDB_NAME = 'financial_dashboard_idb';
const IDB_STORE = 'funds';

// --- DATA MANAGER (IndexedDB) ---
class DataManager {
    static _db = {};      // in-memory cache
    static _idb = null;   // IndexedDB handle

    // Call once at startup; resolves when data is loaded into memory
    static async init() {
        return new Promise((resolve) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = (e) => {
                e.target.result.createObjectStore(IDB_STORE);
            };
            req.onsuccess = async (e) => {
                this._idb = e.target.result;
                // Try to load from IndexedDB
                const saved = await this._idbGet();
                if (saved && Object.keys(saved).length > 0) {
                    this._db = saved;
                } else {
                    // Migrate from localStorage if it exists
                    const lsRaw = localStorage.getItem(STORAGE_KEY);
                    if (lsRaw) {
                        try {
                            this._db = JSON.parse(lsRaw);
                            await this._idbSet(this._db);
                            localStorage.removeItem(STORAGE_KEY);
                        } catch (_) { this._db = {}; }
                    } else {
                        this._db = {};
                    }
                }
                resolve();
            };
            req.onerror = () => {
                // Fallback: use localStorage (old behaviour)
                const lsRaw = localStorage.getItem(STORAGE_KEY);
                this._db = lsRaw ? JSON.parse(lsRaw) : {};
                resolve();
            };
        });
    }

    static _idbGet() {
        return new Promise((resolve) => {
            if (!this._idb) { resolve(null); return; }
            const tx = this._idb.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get('main');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror  = () => resolve(null);
        });
    }

    static _idbSet(data) {
        return new Promise((resolve, reject) => {
            if (!this._idb) { reject(new Error('IndexedDB not ready')); return; }
            const tx = this._idb.transaction(IDB_STORE, 'readwrite');
            const req = tx.objectStore(IDB_STORE).put(data, 'main');
            req.onsuccess = () => resolve();
            req.onerror  = () => reject(req.error);
        });
    }

    static getDB() { return this._db; }

    static async saveDB(db) {
        this._db = db;
        if (this._idb) {
            await this._idbSet(db);
        } else {
            // Fallback to localStorage
            localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        }
    }

    static async bulkImport(records) {
        const db = this.getDB();
        records.forEach(r => {
            if (!db[r.fundName]) {
                db[r.fundName] = { name: r.fundName, classification: r.classification, currencies: {} };
            } else if (r.classification && !db[r.fundName].classification) {
                db[r.fundName].classification = r.classification;
            }
            if (!db[r.fundName].currencies[r.currency]) {
                db[r.fundName].currencies[r.currency] = { records: {} };
            }
            db[r.fundName].currencies[r.currency].records[r.date] = r.value;
        });
        await this.saveDB(db);
    }

    static addFundRecord(fundName, date, currency, value, classification = '') {
        this.bulkImport([{fundName, date, currency, value, classification}]);
    }

    static deleteRecord(fundName, date) {
        const db = this.getDB();
        if (!db[fundName]) return;
        Object.keys(db[fundName].currencies).forEach(curr => {
            if (db[fundName].currencies[curr].records[date] !== undefined) {
                delete db[fundName].currencies[curr].records[date];
            }
        });
        this.saveDB(db); // fire-and-forget
    }

    static async clearAll() {
        if (confirm('¿Estás seguro de borrar TODA la base de datos de fondos? Esto no se puede deshacer.')) {
            this._db = {};
            if (this._idb) {
                await this._idbSet({});
            } else {
                localStorage.removeItem(STORAGE_KEY);
            }
            return true;
        }
        return false;
    }

    static getFundList() {
        return Object.keys(this.getDB()).sort();
    }

    static getFundData(fundName) {
        return this.getDB()[fundName] || null;
    }
}

// --- CALCULATOR ---
class Calculator {
    static getProcessedData(fundName) {
        const fund = DataManager.getFundData(fundName);
        if (!fund) return null;

        const processed = {
            name: fund.name,
            classification: fund.classification,
            currencies: {}
        };

        Object.keys(fund.currencies).forEach(curr => {
            const recordsObj = fund.currencies[curr].records;
            const dates = Object.keys(recordsObj).sort((a, b) => new Date(a) - new Date(b));
            
            const arr = [];
            let baseValue = null;
            let baseDate = null;

            dates.forEach(date => {
                const val = recordsObj[date];
                if (baseValue === null && val !== null && val !== undefined) {
                    baseValue = val;
                    baseDate = date;
                }
                
                let variation = 0;
                if (baseValue && baseValue !== 0) {
                    variation = ((val - baseValue) / baseValue) * 100;
                }

                arr.push({
                    date: date,
                    value: val,
                    variation: variation,
                    isBase: date === baseDate
                });
            });

            processed.currencies[curr] = arr;
        });

        return processed;
    }

    static getStats(processedFundData) {
        if (!processedFundData) return null;
        const stats = {};

        Object.keys(processedFundData.currencies).forEach(curr => {
            const arr = processedFundData.currencies[curr];
            if (arr.length === 0) return;

            const latest = arr[arr.length - 1];
            
            let maxRecord = arr[0];
            let minRecord = arr[0];
            for (let i = 1; i < arr.length; i++) {
                if (arr[i].variation > maxRecord.variation) {
                    maxRecord = arr[i];
                }
                if (arr[i].variation < minRecord.variation) {
                    minRecord = arr[i];
                }
            }

            const yearlyReturns = {};
            const years = [...new Set(arr.map(d => d.date.substring(0, 4)))].sort();
            let previousYearEndValue = null;

            years.forEach((year, idx) => {
                const yearData = arr.filter(d => d.date.startsWith(year));
                if (yearData.length === 0) return;

                const firstRecordOfYear = yearData[0];
                const lastRecordOfYear = yearData[yearData.length - 1];

                let startValue;
                if (idx === 0 || previousYearEndValue === null) {
                    startValue = firstRecordOfYear.value;
                } else {
                    startValue = previousYearEndValue;
                }
                
                const endValue = lastRecordOfYear.value;
                let variation = 0;
                if (startValue && startValue !== 0) {
                    variation = ((endValue - startValue) / startValue) * 100;
                }
                
                yearlyReturns[year] = variation;
                previousYearEndValue = endValue;
            });

            stats[curr] = {
                currentValue: latest.value,
                currentVariation: latest.variation,
                maxVal: maxRecord.value,
                minVal: minRecord.value,
                maxVar: maxRecord.variation,
                minVar: minRecord.variation,
                maxDate: maxRecord.date,
                minDate: minRecord.date,
                latestDate: latest.date,
                yearlyReturns
            };
        });

        return stats;
    }
}

// --- UI CONTROLLER ---
class UIController {
    static currentChartRange = 'all';
    static currentFund = null;

    static init() {
        this.fundSelector = document.getElementById('fund-selector');

        // Events
        this.fundSelector.addEventListener('change', (e) => this.selectFund(e.target.value));
        
        document.getElementById('btn-clear-all').addEventListener('click', async () => {
            if(await DataManager.clearAll()) {
                this.updateFundList();
                this.selectFund(null);
                if (typeof ComparisonController !== 'undefined') {
                    ComparisonController.clearSelection();
                }
            }
        });
        
        const importInput = document.getElementById('file-import');
        document.getElementById('btn-import').addEventListener('click', () => importInput.click());
        importInput.addEventListener('change', this.importExcel.bind(this));

        // Tab switching events
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.currentTarget.dataset.tab;
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                
                if (tab === 'individual') {
                    document.getElementById('comparison-content').style.display = 'none';
                    if (this.currentFund) {
                        document.getElementById('main-content').style.display = 'block';
                        document.getElementById('empty-state').style.display = 'none';
                    } else {
                        document.getElementById('main-content').style.display = 'none';
                        document.getElementById('empty-state').style.display = 'flex';
                    }
                } else if (tab === 'comparison') {
                    document.getElementById('main-content').style.display = 'none';
                    document.getElementById('empty-state').style.display = 'none';
                    document.getElementById('comparison-content').style.display = 'block';
                    ComparisonController.init();
                }
            });
        });

        // Chart filters
        document.querySelectorAll('.btn-filter').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentChartRange = e.target.dataset.range;
                this.updateChartsOnly();
            });
        });

        this.updateFundList();
        this.selectFund(null);
    }

    static updateFundList() {
        const list = document.getElementById('fund-list');
        list.innerHTML = '';
        const funds = DataManager.getFundList();
        funds.forEach(f => {
            const option = document.createElement('option');
            option.value = f;
            list.appendChild(option);
        });
    }

    static selectFund(fundName) {
        if (!fundName || !DataManager.getFundData(fundName)) {
            this.currentFund = null;
            document.getElementById('empty-state').style.display = 'flex';
            document.getElementById('main-content').style.display = 'none';
            this.fundSelector.value = '';
            return;
        }

        this.currentFund = fundName;
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('main-content').style.display = 'block';
        
        const processed = Calculator.getProcessedData(fundName);
        
        document.getElementById('display-fund-name').textContent = processed.name;
        document.getElementById('display-fund-class').textContent = processed.classification || 'Sin clasificación';

        this.updateAll();
    }

    static handleDelete(date) {
        if(!confirm('¿Eliminar todos los registros de este fondo para esta fecha?')) return;
        DataManager.deleteRecord(this.currentFund, date);
        this.updateAll();
    }

    static updateAll() {
        if(!this.currentFund) return;
        const processedData = Calculator.getProcessedData(this.currentFund);
        const stats = Calculator.getStats(processedData);

        this.renderStats(stats);
        this.renderTable(processedData);
        this.updateChartsOnly();
    }

    static updateChartsOnly() {
        if(!this.currentFund) return;
        const processedData = Calculator.getProcessedData(this.currentFund);
        ChartController.updateCharts(processedData, this.currentChartRange);
    }

    static formatPercent(value) {
        const prefix = value > 0 ? '+' : '';
        return `${prefix}${value.toFixed(2)}%`;
    }

    static formatDate(dateString) {
        if(!dateString) return '';
        const parts = dateString.split('-');
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    
    static getBadgeClass(val) {
        return val > 0 ? 'positive' : (val < 0 ? 'negative' : 'neutral');
    }

    static getIcon(val) {
        return val > 0 ? '<i class="fa-solid fa-arrow-trend-up"></i>' : (val < 0 ? '<i class="fa-solid fa-arrow-trend-down"></i>' : '<i class="fa-solid fa-minus"></i>');
    }

    static renderStats(stats) {
        const container = document.getElementById('dynamic-stats');
        container.innerHTML = '';
        if (!stats) return;

        Object.keys(stats).forEach(curr => {
            const st = stats[curr];
            const normalizedCurr = curr.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const isUsd = normalizedCurr.includes('USD') || normalizedCurr.includes('DOLAR') || normalizedCurr === '$';
            const icon = isUsd ? '<i class="fa-solid fa-dollar-sign"></i>' : '<i class="fa-solid fa-money-bill"></i>';
            const colorClass = isUsd ? 'color: #f59e0b;' : 'color: var(--accent-primary);';
            const valClass = st.currentVariation > 0 ? 'positive' : (st.currentVariation < 0 ? 'negative' : '');
            const valClassMax = st.maxVar > 0 ? 'positive' : (st.maxVar < 0 ? 'negative' : '');
            const valClassMin = st.minVar > 0 ? 'positive' : (st.minVar < 0 ? 'negative' : '');

            container.innerHTML += `
                <div class="stat-card">
                    <div class="stat-icon" style="${colorClass}">${icon}</div>
                    <div class="stat-info">
                        <span class="stat-label">Rendimiento (${curr})</span>
                        <h2 class="stat-value ${valClass}">${this.formatPercent(st.currentVariation)}</h2>
                        <span class="stat-subtext">Valor: ${st.currentValue.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                    </div>
                </div>
                <div class="stat-card compact-stats">
                    <div class="stat-row">
                        <span class="stat-label">Máx Histórico (${curr}):</span>
                        <span class="stat-value-small ${valClassMax}">${this.formatPercent(st.maxVar)}<span class="stat-date">(${this.formatDate(st.maxDate)})</span></span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Mín Histórico (${curr}):</span>
                        <span class="stat-value-small ${valClassMin}">${this.formatPercent(st.minVar)}<span class="stat-date">(${this.formatDate(st.minDate)})</span></span>
                    </div>
                </div>
            `;

        });
    }

    static renderTable(processedFundData) {
        const thead = document.getElementById('table-head');
        const tbody = document.getElementById('table-body');
        
        const currencies = Object.keys(processedFundData.currencies).sort();
        
        // Thead
        let headRow = `<tr><th>Fecha <i class="fa-solid fa-sort"></i></th>`;
        currencies.forEach(c => {
            headRow += `<th>Valor ${c}</th><th>Var. ${c} (%)</th>`;
        });
        headRow += `<th>Acciones</th></tr>`;
        thead.innerHTML = headRow;

        // Tbody
        tbody.innerHTML = '';
        const allDatesSet = new Set();
        currencies.forEach(c => {
            processedFundData.currencies[c].forEach(d => allDatesSet.add(d.date));
        });
        const sortedDates = Array.from(allDatesSet).sort((a,b) => new Date(b) - new Date(a));

        sortedDates.forEach(date => {
            const tr = document.createElement('tr');
            let isBaseForAny = false;
            
            let rowHtml = `<td>${this.formatDate(date)}</td>`;
            
            currencies.forEach(c => {
                const record = processedFundData.currencies[c].find(r => r.date === date);
                if (record) {
                    if (record.isBase) isBaseForAny = true;
                    rowHtml += `<td>${record.value.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>`;
                    rowHtml += `<td><span class="badge ${this.getBadgeClass(record.variation)}">${this.getIcon(record.variation)} ${this.formatPercent(record.variation)}</span></td>`;
                } else {
                    rowHtml += `<td>-</td><td>-</td>`;
                }
            });
            
            if (isBaseForAny) {
                 rowHtml = rowHtml.replace('</td>', ' <span class="badge neutral">Base</span></td>');
            }

            rowHtml += `
                <td>
                    <button class="btn-icon delete" onclick="UIController.handleDelete('${date}')" title="Eliminar">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            `;
            tr.innerHTML = rowHtml;
            tbody.appendChild(tr);
        });
    }

    static importExcel(e) {
        const file = e.target.files[0];
        if (!file) return;

        document.getElementById('empty-state').querySelector('h2').textContent = 'Procesando archivo...';

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const data = new Uint8Array(event.target.result);
                const workbook = XLSX.read(data, {type: 'array'});
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, {header: 1, defval: null});
                
                const headerRow = json[0] || [];
                const datesMap = {}; 
                
                // Parse dates from Col E (index 4) onwards
                for (let c = 4; c < headerRow.length; c++) {
                    let cellVal = headerRow[c];
                    if (cellVal === null || cellVal === undefined || cellVal === '') break;
                    
                    let parsedDate = null;
                    if (typeof cellVal === 'number') {
                        const jsDate = new Date(Math.round((cellVal - 25569) * 86400 * 1000));
                        parsedDate = jsDate.toISOString().split('T')[0];
                    } else if (typeof cellVal === 'string') {
                        const parts = cellVal.split(/[\/\-]/);
                        if (parts.length === 3) {
                            let day = parts[0], month = parts[1], year = parts[2];
                            if (year.length === 2) year = "20" + year; 
                            parsedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                        } else {
                            const dateObj = new Date(cellVal);
                            if (!isNaN(dateObj.getTime())) parsedDate = dateObj.toISOString().split('T')[0];
                        }
                    }
                    
                    if (parsedDate) datesMap[c] = parsedDate;
                    else break;
                }

                const newRecords = [];
                // Parse Data Rows
                for (let i = 1; i < json.length; i++) {
                    const row = json[i];
                    if (!row || !row[0]) continue; 

                    let fundName = String(row[0]).trim();
                    let currency = row[1] ? String(row[1]).trim().toUpperCase() : 'UNKNOWN';
                    let classification = row[2] ? String(row[2]).trim() : '';

                    for (let c = 4; c < row.length; c++) {
                        if (!datesMap[c]) break; 
                        
                        let valStr = row[c];
                        if (valStr === null || valStr === undefined || valStr === '') continue;

                        let valNum = valStr;
                        if (typeof valStr === 'string') {
                            valStr = valStr.replace(/[a-zA-Z$\s]/g, '');
                            if (valStr.includes(',') && valStr.includes('.')) {
                                valStr = valStr.replace(/\./g, '').replace(',', '.');
                            } else if (valStr.includes(',')) {
                                valStr = valStr.replace(',', '.');
                            }
                            valNum = parseFloat(valStr);
                        }

                        if (!isNaN(valNum)) {
                            newRecords.push({
                                fundName, currency, classification, date: datesMap[c], value: valNum
                            });
                        }
                    }
                }
                
                await DataManager.bulkImport(newRecords);
                alert(`Se importaron ${newRecords.length} datos de fondos correctamente.`);
                
                this.updateFundList();
                if (typeof ComparisonController !== 'undefined') {
                    ComparisonController.updateSelectorList();
                    ComparisonController.renderCurrencySelectors();
                }
                document.getElementById('empty-state').querySelector('h2').textContent = 'Selecciona un fondo';
                
            } catch (err) {
                alert('Hubo un error procesando el archivo:\n' + err.message);
                console.error(err);
            }
            e.target.value = ''; 
        };
        reader.readAsArrayBuffer(file);
    }
}

// --- CHART CONTROLLER ---
class ChartController {
    static chartInstances = {};

    static updateCharts(processedFundData, range) {
        const container = document.getElementById('charts-container');
        container.innerHTML = ''; 
        
        Object.values(this.chartInstances).forEach(c => c.destroy());
        this.chartInstances = {};

        const currencies = Object.keys(processedFundData.currencies);
        const stats = Calculator.getStats(processedFundData);
        
        currencies.forEach((curr, index) => {
            let dataArr = processedFundData.currencies[curr];
            if (range !== 'all' && dataArr.length > 0) {
                const sortedData = [...dataArr].sort((a, b) => new Date(a.date) - new Date(b.date));
                const latestDate = new Date(sortedData[sortedData.length - 1].date);
                let cutoffDate = new Date(latestDate);

                switch(range) {
                    case '1m': cutoffDate.setMonth(cutoffDate.getMonth() - 1); break;
                    case '3m': cutoffDate.setMonth(cutoffDate.getMonth() - 3); break;
                    case '6m': cutoffDate.setMonth(cutoffDate.getMonth() - 6); break;
                    case '1y': cutoffDate.setFullYear(cutoffDate.getFullYear() - 1); break;
                    case 'ytd': cutoffDate = new Date(latestDate.getFullYear(), 0, 1); break;
                }
                dataArr = sortedData.filter(d => new Date(d.date) >= cutoffDate);
            }
            
            let yearlyHtml = '';
            if (stats && stats[curr] && stats[curr].yearlyReturns && Object.keys(stats[curr].yearlyReturns).length > 0) {
                const displayYears = Object.keys(stats[curr].yearlyReturns).filter(year => year !== '2019').sort();
                if (displayYears.length > 0) {
                    yearlyHtml = `
                        <div class="yearly-returns-chart-footer">
                            <div class="yearly-returns-header">
                                <span class="stat-label">Rentabilidad por Año</span>
                            </div>
                            <div class="yearly-returns-grid">
                    `;
                    displayYears.forEach(year => {
                        const yVar = stats[curr].yearlyReturns[year];
                        const yClass = yVar > 0 ? 'positive' : (yVar < 0 ? 'negative' : 'neutral');
                        yearlyHtml += `
                            <div class="yearly-return-item">
                                <span class="year-label">${year}</span>
                                <span class="badge ${yClass}">${UIController.formatPercent(yVar)}</span>
                            </div>
                        `;
                    });
                    yearlyHtml += `</div></div>`;
                }
            }

            const card = document.createElement('div');
            card.className = 'chart-card';
            card.innerHTML = `
                <div class="card-header">
                    <h3>Evolución (${curr})</h3>
                </div>
                <div class="chart-container">
                    <canvas id="chart-${curr}"></canvas>
                </div>
                ${yearlyHtml}
            `;
            container.appendChild(card);

            const normalizedCurr = curr.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const isUsd = normalizedCurr.includes('USD') || normalizedCurr.includes('DOLAR') || normalizedCurr === '$';
            const ctx = document.getElementById(`chart-${curr}`).getContext('2d');
            const color = isUsd ? '#f59e0b' : '#3b82f6';
            const bgColor = isUsd ? 'rgba(245, 158, 11, 0.1)' : 'rgba(59, 130, 246, 0.1)';

            this.chartInstances[curr] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: dataArr.map(d => UIController.formatDate(d.date)),
                    datasets: [{
                        label: `Variación %`, // Plotting % Variation as Y axis
                        data: dataArr.map(d => d.variation),
                        borderColor: color,
                        backgroundColor: bgColor,
                        borderWidth: 2,
                        pointBackgroundColor: color,
                        pointRadius: 2,
                        fill: true,
                        tension: 0.4,
                        rawValues: dataArr.map(d => d.value) // custom property for tooltip
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(15, 23, 42, 0.9)',
                            callbacks: {
                                label: function(context) {
                                    const variation = context.parsed.y.toFixed(2) + '%';
                                    const rawValue = context.dataset.rawValues[context.dataIndex].toLocaleString(undefined, {minimumFractionDigits: 2});
                                    return `Var: ${variation} | Valor: ${rawValue}`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { color: 'rgba(255, 255, 255, 0.05)' } },
                        y: { 
                            grid: { color: 'rgba(255, 255, 255, 0.05)' },
                            ticks: { callback: function(value) { return value + '%'; } }
                        }
                    }
                }
            });
        });
    }
}

// --- COMPARISON CONTROLLER ---
class ComparisonController {
    static selectedFunds = new Set();
    static selectedCurrency = 'CLP';
    static currentRange = 'all';
    static chartInstance = null;

    static init() {
        // Renderizar monedas PRIMERO para que selectedCurrency sea correcto
        this.renderCurrencySelectors();
        // Ahora sí renderizar la lista de fondos con la moneda correcta
        this.updateSelectorList();
        
        // Listeners for range filters (comp)
        document.querySelectorAll('.btn-filter-comp').forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });
        
        document.querySelectorAll('.btn-filter-comp').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.btn-filter-comp').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentRange = e.target.dataset.range;
                this.updateComparison();
            });
        });

        // Fund search filter
        const searchInput = document.getElementById('comparison-fund-search');
        if (searchInput) {
            searchInput.value = '';
            searchInput.oninput = () => {
                const query = searchInput.value.trim().toLowerCase();
                document.querySelectorAll('#comparison-funds-list .fund-checkbox-item').forEach(item => {
                    const name = item.querySelector('span')?.textContent?.toLowerCase() || '';
                    item.style.display = name.includes(query) ? '' : 'none';
                });
            };
        }
        
        this.updateComparison();
    }

    static clearSelection() {
        this.selectedFunds.clear();
        const searchInput = document.getElementById('comparison-fund-search');
        if (searchInput) searchInput.value = '';
        this.updateSelectorList();
        this.updateComparison();
        // Clear yearly returns section
        const yr1 = document.getElementById('comparison-yearly-returns');
        if (yr1) yr1.innerHTML = '';
    }

    static updateSelectorList() {
        const container = document.getElementById('comparison-funds-list');
        if (!container) return;
        
        container.innerHTML = '';
        const funds = DataManager.getFundList();
        
        if (funds.length === 0) {
            container.innerHTML = '<span class="text-muted" style="font-size: 0.85rem;">No hay fondos cargados</span>';
            return;
        }

        funds.forEach(f => {
            const data = DataManager.getFundData(f);
            const hasSelectedCurr = data && data.currencies && data.currencies[this.selectedCurrency];
            const disabledClass = hasSelectedCurr ? '' : 'disabled';
            const isChecked = this.selectedFunds.has(f) && hasSelectedCurr ? 'checked' : '';
            
            if (this.selectedFunds.has(f) && !hasSelectedCurr) {
                this.selectedFunds.delete(f);
            }

            const item = document.createElement('label');
            item.className = `fund-checkbox-item ${disabledClass}`;
            item.innerHTML = `
                <input type="checkbox" data-fund="${f}" ${isChecked} ${hasSelectedCurr ? '' : 'disabled'}>
                <span>${f}</span>
            `;
            
            const checkbox = item.querySelector('input');
            checkbox.addEventListener('change', (e) => {
                const fundName = e.target.dataset.fund;
                if (e.target.checked) {
                    this.selectedFunds.add(fundName);
                } else {
                    this.selectedFunds.delete(fundName);
                }
                this.updateComparison();
            });

            container.appendChild(item);
        });
    }

    static renderCurrencySelectors() {
        const container = document.getElementById('comparison-currency-selector');
        if (!container) return;
        
        const db = DataManager.getDB();
        const currenciesSet = new Set();
        Object.keys(db).forEach(f => {
            Object.keys(db[f].currencies).forEach(c => currenciesSet.add(c));
        });
        
        let currencies = Array.from(currenciesSet).sort();
        if (currencies.length === 0) {
            currencies = ['CLP'];
        }
        
        if (!currencies.includes(this.selectedCurrency)) {
            this.selectedCurrency = currencies[0];
        }

        container.innerHTML = '';
        currencies.forEach(c => {
            const btn = document.createElement('button');
            btn.className = `btn-curr ${this.selectedCurrency === c ? 'active' : ''}`;
            btn.textContent = c;
            btn.addEventListener('click', () => {
                this.selectedCurrency = c;
                document.querySelectorAll('#comparison-currency-selector .btn-curr').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                this.updateSelectorList();
                this.updateComparison();
            });
            container.appendChild(btn);
        });
    }

    static updateComparison() {
        const emptyState = document.getElementById('comparison-empty-state');
        const results = document.getElementById('comparison-results');
        
        if (!emptyState || !results) return;

        if (this.selectedFunds.size === 0) {
            emptyState.style.display = 'flex';
            results.style.display = 'none';
            if (this.chartInstance) {
                this.chartInstance.destroy();
                this.chartInstance = null;
            }
            // Clear yearly returns section
            const yr2 = document.getElementById('comparison-yearly-returns');
            if (yr2) yr2.innerHTML = '';
            return;
        }

        emptyState.style.display = 'none';
        results.style.display = 'block';

        this.renderComparisonChart();
        this.renderComparisonTable();
        this.renderYearlyReturns(); // render yearly returns below chart
    }

    static renderComparisonChart() {
        const ctx = document.getElementById('comparison-chart').getContext('2d');
        if (this.chartInstance) {
            this.chartInstance.destroy();
        }

        const PALETTE = ['#3b82f6', '#f59e0b', '#a855f7', '#10b981', '#ec4899', '#06b6d4', '#f43f5e', '#84cc16'];
        
        const processedData = {};
        this.selectedFunds.forEach(fundName => {
            processedData[fundName] = Calculator.getProcessedData(fundName);
        });

        const allDatesSet = new Set();
        this.selectedFunds.forEach(fundName => {
            const data = processedData[fundName];
            if (data && data.currencies[this.selectedCurrency]) {
                data.currencies[this.selectedCurrency].forEach(d => allDatesSet.add(d.date));
            }
        });
        const sortedDates = Array.from(allDatesSet).sort((a, b) => new Date(a) - new Date(b));

        let filteredDates = sortedDates;
        if (this.currentRange !== 'all' && filteredDates.length > 0) {
            const latestDate = new Date(filteredDates[filteredDates.length - 1]);
            let cutoffDate = new Date(latestDate);
            switch(this.currentRange) {
                case '1m': cutoffDate.setMonth(cutoffDate.getMonth() - 1); break;
                case '3m': cutoffDate.setMonth(cutoffDate.getMonth() - 3); break;
                case '6m': cutoffDate.setMonth(cutoffDate.getMonth() - 6); break;
                case '1y': cutoffDate.setFullYear(cutoffDate.getFullYear() - 1); break;
                case 'ytd': cutoffDate = new Date(latestDate.getFullYear(), 0, 1); break;
            }
            filteredDates = sortedDates.filter(d => new Date(d) >= cutoffDate);
        }

        const datasets = [];
        let colorIdx = 0;
        this.selectedFunds.forEach(fundName => {
            const data = processedData[fundName];
            if (!data || !data.currencies[this.selectedCurrency]) return;
            
            const arr = data.currencies[this.selectedCurrency];
            const recordsMap = new Map(arr.map(r => [r.date, r.variation]));
            const valuesMap = new Map(arr.map(r => [r.date, r.value]));

            const dataPoints = filteredDates.map(d => {
                const variation = recordsMap.get(d);
                return variation !== undefined ? variation : null;
            });
            
            const rawValues = filteredDates.map(d => {
                const val = valuesMap.get(d);
                return val !== undefined ? val : null;
            });

            const color = PALETTE[colorIdx % PALETTE.length];
            colorIdx++;

            datasets.push({
                label: fundName,
                data: dataPoints,
                borderColor: color,
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointBackgroundColor: color,
                pointRadius: filteredDates.length > 60 ? 0 : 2,
                fill: false,
                tension: 0.3,
                spanGaps: true,
                rawValues: rawValues
            });
        });

        this.chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: filteredDates.map(d => UIController.formatDate(d)),
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: '#94a3b8',
                            font: { family: "'Inter', sans-serif", weight: '500' }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        callbacks: {
                            label: function(context) {
                                const dataset = context.dataset;
                                const index = context.dataIndex;
                                const variation = context.parsed.y.toFixed(2) + '%';
                                const rawValue = dataset.rawValues[index];
                                const formattedValue = rawValue !== null && rawValue !== undefined 
                                    ? rawValue.toLocaleString(undefined, {minimumFractionDigits: 2})
                                    : '-';
                                return `${dataset.label}: Var: ${variation} | Valor: ${formattedValue}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(255, 255, 255, 0.05)' } },
                    y: { 
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { callback: function(value) { return value + '%'; } }
                    }
                }
            }
        });
    }

    static renderComparisonTable() {
        const tbody = document.getElementById('comparison-table-body');
        if (!tbody) return;

        tbody.innerHTML = '';
        
        this.selectedFunds.forEach(fundName => {
            const processed = Calculator.getProcessedData(fundName);
            const stats = Calculator.getStats(processed);
            
            if (!stats || !stats[this.selectedCurrency]) return;
            const st = stats[this.selectedCurrency];

            const valClassMax = st.maxVar > 0 ? 'positive' : (st.maxVar < 0 ? 'negative' : '');
            const valClassMin = st.minVar > 0 ? 'positive' : (st.minVar < 0 ? 'negative' : '');

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight: 600;">${fundName}</td>
                <td><span class="badge ${UIController.getBadgeClass(st.currentVariation)}">${UIController.getIcon(st.currentVariation)} ${UIController.formatPercent(st.currentVariation)}</span></td>
                <td>${st.currentValue.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td><span class="stat-value-small ${valClassMax}">${UIController.formatPercent(st.maxVar)}<span class="stat-date">(${UIController.formatDate(st.maxDate)})</span></span></td>
                <td><span class="stat-value-small ${valClassMin}">${UIController.formatPercent(st.minVar)}<span class="stat-date">(${UIController.formatDate(st.minDate)})</span></span></td>
                <td>${UIController.formatDate(st.latestDate)}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    static renderYearlyReturns() {
        const container = document.getElementById('comparison-yearly-returns');
        if (!container) return;
        container.innerHTML = '';
        this.selectedFunds.forEach(fundName => {
            const processed = Calculator.getProcessedData(fundName);
            const stats = Calculator.getStats(processed);
            if (!stats || !stats[this.selectedCurrency]) return;
            const yearly = stats[this.selectedCurrency].yearlyReturns;
            const displayYears = Object.keys(yearly).filter(y => y !== '2019').sort();
            if (displayYears.length === 0) return;
            let html = `<div class="yearly-returns-chart-footer">
                <div class="yearly-returns-header"><span class="stat-label">${fundName} - Rentabilidad por Año</span></div>
                <div class="yearly-returns-grid">`;
            displayYears.forEach(year => {
                const val = yearly[year];
                const cls = val > 0 ? 'positive' : (val < 0 ? 'negative' : 'neutral');
                html += `<div class="yearly-return-item">
                    <span class="year-label">${year}</span>
                    <span class="badge ${cls}">${UIController.formatPercent(val)}</span>
                </div>`;
            });
            html += `</div></div>`;
            container.insertAdjacentHTML('beforeend', html);
        });
    }

}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'Inter', sans-serif";
    await DataManager.init();
    UIController.init();
});
