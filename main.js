geotab.addin.passengerReport = function (api, state) {

    // ─── CONSTANTES ────────────────────────────────────────────────────────────
    // ID de la regla de excepción de apertura de puertas (tu regla actual)
    const RULE_ID = "aDvSGnsFqwU6HY0-rtpPgkA";

    // IDs de diagnósticos de puerta (para consulta directa de StatusData como fallback)
    const DOOR_DIAGNOSTICS = [
        "aI7zmF_XrH0GOVvlNJIsj0w",          // Puerta del pasajero abierta
        "DiagnosticLeftRearDoorOpenId",       // Puerta trasera izquierda
        "DiagnosticRightRearDoorOpenId"       // Puerta trasera derecha
    ];

    // ─── UTILIDADES ────────────────────────────────────────────────────────────
    const fmt = {
        time: (ms) => {
            if (!ms || ms < 0) return "0 min";
            const h = Math.floor(ms / 3600000);
            const m = Math.floor((ms % 3600000) / 60000);
            return h > 0 ? `${h}h ${m}m` : `${m} min`;
        },
        km: (m) => (m / 1000).toFixed(1),    // Geotab Trip.distance está en METROS
        pct: (a, b) => (a + b) > 0 ? Math.round((a / (a + b)) * 100) : 0,
        localISO: (dateStr, endOfDay = false) => {
            // Respeta la timezone local del navegador en lugar de forzar UTC
            const d = new Date(dateStr);
            if (endOfDay) { d.setHours(23, 59, 59, 999); }
            else          { d.setHours(0,  0,  0,  0); }
            return d.toISOString();
        }
    };

    let currentReportData = [];
    let chartOccupancy = null;
    let chartFleet = null;

    // ─── LÓGICA PRINCIPAL ───────────────────────────────────────────────────────
    /**
     * CORRECCIÓN CRÍTICA DE LÓGICA:
     * 
     * La regla de excepción de puerta genera eventos MUY BREVES (3-15 segundos)
     * en el momento de apertura. NO abarcan toda la duración del viaje.
     * 
     * Estrategia correcta:
     * 1. Obtener todos los ExceptionEvents de apertura de puerta del día
     * 2. Obtener todos los Trips del día por vehículo
     * 3. Para cada viaje: buscar si DENTRO DEL VIAJE o en los 3 minutos previos
     *    al inicio del viaje hubo una apertura de puerta
     * 4. Si hubo apertura → viaje OCUPADO
     * 5. Si no hubo apertura → viaje VACÍO
     * 
     * Razonamiento: el conductor para, el pasajero abre la puerta y sube,
     * el evento de puerta se genera. El viaje siguiente a ese evento = ocupado.
     */
    const classifyTrip = (trip, doorEvents) => {
        const tStart = new Date(trip.start).getTime();
        const tStop  = new Date(trip.stop).getTime();
        const WINDOW_BEFORE = 3 * 60 * 1000; // 3 min antes del inicio del viaje
        const WINDOW_AFTER  = 2 * 60 * 1000; // 2 min después del inicio (pasajero tarda en cerrar)

        return doorEvents.some(ev => {
            const evTime = new Date(ev.activeFrom).getTime();
            // La puerta se abrió dentro del viaje, o justo antes de que empezara
            return evTime >= (tStart - WINDOW_BEFORE) && evTime <= (tStart + WINDOW_AFTER);
        });
    };

    const runReport = async (fromDateStr, toDateStr, deviceIds) => {
        const fromDate = fmt.localISO(fromDateStr, false);
        const toDate   = fmt.localISO(toDateStr,   true);

        showLoading(true);

        try {
            // Consultas paralelas para máxima velocidad
            const deviceSearch = deviceIds.length > 0
                ? { id: deviceIds.join(',') }   // Geotab acepta IDs separados por coma como OR
                : undefined;

            const [devices, allTrips, allExceptions] = await Promise.all([
                api.call("Get", { typeName: "Device", search: deviceIds.length > 0 ? { id: deviceIds } : {} }),
                api.call("Get", { typeName: "Trip",   search: { fromDate, toDate } }),
                api.call("Get", { typeName: "ExceptionEvent", search: {
                    ruleSearch: { id: RULE_ID },
                    fromDate,
                    toDate
                }})
            ]);

            // Filtrar solo los dispositivos seleccionados
            const filteredDevices = deviceIds.length > 0
                ? devices.filter(d => deviceIds.includes(d.id))
                : devices;

            const report = [];

            for (const dev of filteredDevices) {
                const devTrips = allTrips
                    .filter(t => t.device.id === dev.id)
                    .sort((a, b) => new Date(a.start) - new Date(b.start));

                const devDoorEvents = allExceptions
                    .filter(e => e.device.id === dev.id)
                    .sort((a, b) => new Date(a.activeFrom) - new Date(b.activeFrom));

                // Solo incluir vehículos que tuvieron actividad
                if (devTrips.length === 0) continue;

                let s = {
                    id: dev.id,
                    name: dev.name,
                    occTrips: 0, occKm: 0, occTimeMs: 0,
                    vacTrips: 0, vacKm: 0, vacTimeMs: 0,
                    doorEvents: devDoorEvents.length,
                    tripDetails: []
                };

                for (const trip of devTrips) {
                    const distKm = parseFloat(fmt.km(trip.distance || 0));
                    const durMs  = new Date(trip.stop) - new Date(trip.start);
                    // Filtrar micro-viajes (menos de 100m o menos de 30 seg = ruido de datos)
                    if (distKm < 0.1 || durMs < 30000) continue;

                    const occupied = classifyTrip(trip, devDoorEvents);

                    s.tripDetails.push({
                        start: new Date(trip.start),
                        stop:  new Date(trip.stop),
                        distKm,
                        durMs,
                        occupied
                    });

                    if (occupied) {
                        s.occTrips++; s.occKm += distKm; s.occTimeMs += durMs;
                    } else {
                        s.vacTrips++; s.vacKm += distKm; s.vacTimeMs += durMs;
                    }
                }

                if ((s.occTrips + s.vacTrips) > 0) report.push(s);
            }

            report.sort((a, b) => b.occTrips - a.occTrips);
            currentReportData = report;
            renderDashboard(report);

        } catch (err) {
            console.error("[OcupacionVTC]", err);
            showError(`Error al consultar datos: ${err.message || err}`);
        } finally {
            showLoading(false);
        }
    };

    // ─── RENDERIZADO ────────────────────────────────────────────────────────────
    const renderDashboard = (data) => {
        const container = document.getElementById("main-content");

        const totOccKm    = data.reduce((a, v) => a + v.occKm, 0);
        const totVacKm    = data.reduce((a, v) => a + v.vacKm, 0);
        const totOccTrips = data.reduce((a, v) => a + v.occTrips, 0);
        const totVacTrips = data.reduce((a, v) => a + v.vacTrips, 0);
        const totOccTime  = data.reduce((a, v) => a + v.occTimeMs, 0);
        const pctOcc      = fmt.pct(totOccKm, totVacKm);

        container.innerHTML = `
        <!-- KPI GLOBALES -->
        <div class="kpi-grid">
            <div class="kpi-card kpi-occ">
                <div class="kpi-icon">👥</div>
                <div class="kpi-val">${totOccKm.toFixed(1)} <span>km</span></div>
                <div class="kpi-lbl">Km con Pasajero</div>
                <div class="kpi-sub">${totOccTrips} viajes · ${fmt.time(totOccTime)}</div>
            </div>
            <div class="kpi-card kpi-vac">
                <div class="kpi-icon">🚗</div>
                <div class="kpi-val">${totVacKm.toFixed(1)} <span>km</span></div>
                <div class="kpi-lbl">Km en Vacío</div>
                <div class="kpi-sub">${totVacTrips} viajes</div>
            </div>
            <div class="kpi-card kpi-pct">
                <div class="kpi-icon">📊</div>
                <div class="kpi-val">${pctOcc}<span>%</span></div>
                <div class="kpi-lbl">Tasa de Ocupación</div>
                <div class="kpi-sub">${(totOccKm + totVacKm).toFixed(1)} km totales</div>
            </div>
            <div class="kpi-card kpi-fleet">
                <div class="kpi-icon">🚖</div>
                <div class="kpi-val">${data.length}</div>
                <div class="kpi-lbl">Vehículos Activos</div>
                <div class="kpi-sub">${data.reduce((a, v) => a + v.doorEvents, 0)} aperturas detectadas</div>
            </div>
        </div>

        <!-- GRÁFICOS -->
        <div class="charts-row">
            <div class="chart-card">
                <div class="chart-title">Distribución de Km</div>
                <div class="chart-wrap"><canvas id="chartDonut"></canvas></div>
            </div>
            <div class="chart-card chart-card-wide">
                <div class="chart-title">Km por Vehículo</div>
                <div class="chart-wrap"><canvas id="chartFleet"></canvas></div>
            </div>
        </div>

        <!-- BARRA DE OCUPACIÓN GLOBAL -->
        <div class="occ-bar-section">
            <div class="occ-bar-label">
                <span>🟢 Ocupado ${pctOcc}%</span>
                <span>🔴 Vacío ${100 - pctOcc}%</span>
            </div>
            <div class="occ-bar-track">
                <div class="occ-bar-fill" style="width:${pctOcc}%"></div>
            </div>
        </div>

        <!-- TARJETAS POR VEHÍCULO -->
        <div class="section-title">Detalle por Vehículo</div>
        <div class="fleet-grid">
            ${data.map(v => renderVehicleCard(v)).join('')}
        </div>

        <!-- TABLA DETALLADA -->
        <div class="section-title" style="margin-top:30px;">Detalle de Viajes</div>
        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Vehículo</th>
                        <th>Estado</th>
                        <th>Inicio</th>
                        <th>Fin</th>
                        <th>Duración</th>
                        <th>Distancia</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.flatMap(v => v.tripDetails.map(t => `
                    <tr>
                        <td class="td-name">${v.name}</td>
                        <td><span class="badge ${t.occupied ? 'badge-occ' : 'badge-vac'}">${t.occupied ? '👥 OCUPADO' : '⚪ VACÍO'}</span></td>
                        <td>${t.start.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'})}</td>
                        <td>${t.stop.toLocaleTimeString('es-ES',  {hour:'2-digit', minute:'2-digit'})}</td>
                        <td>${fmt.time(t.durMs)}</td>
                        <td class="td-km">${t.distKm.toFixed(1)} km</td>
                    </tr>`)).join('')}
                </tbody>
            </table>
        </div>
        `;

        // Destruir charts previos
        if (chartOccupancy) { chartOccupancy.destroy(); chartOccupancy = null; }
        if (chartFleet)     { chartFleet.destroy();     chartFleet = null; }

        // Donut global
        chartOccupancy = new Chart(document.getElementById("chartDonut"), {
            type: "doughnut",
            data: {
                labels: ["Con Pasajero", "En Vacío"],
                datasets: [{ data: [totOccKm.toFixed(1), totVacKm.toFixed(1)],
                    backgroundColor: ["#10b981", "#e2e8f0"],
                    borderWidth: 0, hoverOffset: 8 }]
            },
            options: {
                cutout: "72%", responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: "bottom", labels: { font: { size: 12 } } },
                    tooltip: { callbacks: { label: (c) => ` ${c.parsed.toFixed(1)} km` } }
                }
            }
        });

        // Barras por vehículo
        chartFleet = new Chart(document.getElementById("chartFleet"), {
            type: "bar",
            data: {
                labels: data.map(v => v.name),
                datasets: [
                    { label: "Km Ocupado", data: data.map(v => v.occKm.toFixed(1)), backgroundColor: "#10b981", borderRadius: 4 },
                    { label: "Km Vacío",   data: data.map(v => v.vacKm.toFixed(1)), backgroundColor: "#e2e8f0", borderRadius: 4 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: "top" } },
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, beginAtZero: true,
                        ticks: { callback: v => v + " km" } }
                }
            }
        });
    };

    const renderVehicleCard = (v) => {
        const pct = fmt.pct(v.occKm, v.vacKm);
        const total = (v.occKm + v.vacKm).toFixed(1);
        return `
        <div class="vehicle-card">
            <div class="vc-header">
                <div class="vc-name">🚖 ${v.name}</div>
                <div class="vc-badge">${v.doorEvents} aperturas</div>
            </div>
            <div class="vc-occ-bar">
                <div class="vc-occ-fill" style="width:${pct}%"></div>
            </div>
            <div class="vc-occ-pct">${pct}% ocupación · ${total} km totales</div>
            <div class="vc-stats">
                <div class="vc-stat vc-stat-occ">
                    <div class="vc-stat-icon">👥</div>
                    <div class="vc-stat-info">
                        <div class="vc-stat-main">${v.occKm.toFixed(1)} km</div>
                        <div class="vc-stat-sub">${v.occTrips} viajes · ${fmt.time(v.occTimeMs)}</div>
                    </div>
                </div>
                <div class="vc-stat vc-stat-vac">
                    <div class="vc-stat-icon">⚪</div>
                    <div class="vc-stat-info">
                        <div class="vc-stat-main">${v.vacKm.toFixed(1)} km</div>
                        <div class="vc-stat-sub">${v.vacTrips} viajes · ${fmt.time(v.vacTimeMs)}</div>
                    </div>
                </div>
            </div>
        </div>`;
    };

    // ─── HELPERS UI ─────────────────────────────────────────────────────────────
    const showLoading = (show) => {
        document.getElementById("loading-overlay").style.display = show ? "flex" : "none";
        document.getElementById("main-content").style.display    = show ? "none" : "block";
    };

    const showError = (msg) => {
        document.getElementById("main-content").innerHTML = `
            <div class="error-box">⚠️ ${msg}</div>`;
    };

    const exportExcel = () => {
        if (!currentReportData.length) { alert("Genera el informe primero"); return; }
        let csv = "\uFEFFVehiculo;Aperturas Puerta;Viajes Ocupado;Km Ocupado;Tiempo Ocupado;Viajes Vacio;Km Vacio;% Ocupacion\n";
        currentReportData.forEach(r => {
            const pct = fmt.pct(r.occKm, r.vacKm);
            csv += `${r.name};${r.doorEvents};${r.occTrips};${r.occKm.toFixed(2).replace('.',',')};${fmt.time(r.occTimeMs)};${r.vacTrips};${r.vacKm.toFixed(2).replace('.',',')};${pct}%\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
        a.download = `Ocupacion_VTC_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
    };

    // ─── INICIALIZACIÓN ─────────────────────────────────────────────────────────
    return {
        initialize(api, state, callback) {
            const today = new Date().toISOString().slice(0, 10);
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

            document.getElementById("date-from").value = yesterday;
            document.getElementById("date-to").value   = yesterday;

            // Cargar dispositivos
            api.call("Get", { typeName: "Device" }).then(devices => {
                const sel = document.getElementById("device-selector");
                devices.sort((a, b) => a.name.localeCompare(b.name)).forEach(d => {
                    const opt = document.createElement("option");
                    opt.value = d.id; opt.textContent = d.name;
                    sel.appendChild(opt);
                });
            });

            document.getElementById("btn-run").addEventListener("click", () => {
                const f = document.getElementById("date-from").value;
                const t = document.getElementById("date-to").value;
                if (!f || !t) { alert("Selecciona rango de fechas"); return; }

                const sel = document.getElementById("device-selector");
                const selectedIds = Array.from(sel.selectedOptions).map(o => o.value);
                runReport(f, t, selectedIds);
            });

            document.getElementById("btn-export").addEventListener("click", exportExcel);
            callback();
        }
    };
};
