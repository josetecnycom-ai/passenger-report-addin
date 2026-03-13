geotab.addin.passengerReport = function (api, state) {
    const RULE_ID = "aDvSGnsFqwU6HY0-rtpPgkA";

    const fetchAllData = async (date) => {
        const fromDate = new Date(date).toISOString();
        const toDate = new Date(new Date(date).setDate(new Date(date).getDate() + 1)).toISOString();

        // 1. Obtener Vehículos, Viajes y Excepciones en paralelo
        const [devices, trips, exceptions] = await Promise.all([
            api.asyncCall("Get", { typeName: "Device" }),
            api.asyncCall("Get", { typeName: "Trip", search: { fromDate, toDate } }),
            api.asyncCall("Get", { typeName: "ExceptionEvent", search: { ruleSearch: { id: RULE_ID }, fromDate, toDate } })
        ]);

        return processLogistics(devices, trips, exceptions);
    };

    const processLogistics = (devices, trips, exceptions) => {
        const report = [];
        
        devices.forEach(dev => {
            const devTrips = trips.filter(t => t.device.id === dev.id);
            const devExcep = exceptions.filter(e => e.device.id === dev.id);
            
            // Lógica de Estado: Empezamos asumiendo que el coche está vacío al inicio del día
            let currentlyOccupied = false;

            devTrips.forEach(trip => {
                // Si hubo una excepción justo antes o durante el inicio de este viaje
                // En este caso, simplificamos: si hay una excepción entre el fin del viaje anterior y este, cambia el estado.
                const hasExcep = devExcep.some(e => 
                    new Date(e.activeFrom) >= new Date(new Date(trip.start).getTime() - 300000) && // 5 min de margen antes
                    new Date(e.activeFrom) <= new Date(trip.start)
                );

                if (hasExcep) currentlyOccupied = !currentlyOccupied;

                report.push({
                    vehicle: dev.name,
                    occupied: currentlyOccupied,
                    start: new Date(trip.start).toLocaleTimeString(),
                    duration: Math.round((new Date(trip.stop) - new Date(trip.start)) / 60000), // min
                    distance: (trip.distance / 1000).toFixed(2)
                });
            });
        });
        return report;
    };

    const renderUI = (data) => {
        const tbody = document.getElementById("results-table-body");
        const summary = document.getElementById("summary-cards");
        
        let totals = { occDist: 0, empDist: 0, occCount: 0, empCount: 0 };
        
        tbody.innerHTML = data.map(row => {
            if (row.occupied) { totals.occDist += parseFloat(row.distance); totals.occCount++; }
            else { totals.empDist += parseFloat(row.distance); totals.empCount++; }

            return `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 12px;">${row.vehicle}</td>
                    <td style="padding: 12px;">
                        <span style="background: ${row.occupied ? '#27ae60' : '#bdc3c7'}; color: white; padding: 4px 8px; border-radius: 12px; font-size: 11px;">
                            ${row.occupied ? '👥 OCUPADO' : '⚪ VACÍO'}
                        </span>
                    </td>
                    <td style="padding: 12px;">${row.start}</td>
                    <td style="padding: 12px;">${row.duration} min</td>
                    <td style="padding: 12px;">${row.distance} km</td>
                </tr>`;
        }).join('');

        summary.innerHTML = `
            <div style="flex:1; background: #27ae60; color: white; padding: 20px; border-radius: 10px;">
                <h4>Viajes Ocupados</h4>
                <p style="font-size: 24px; font-weight: bold;">${totals.occCount} <span style="font-size: 14px;">(${totals.occDist.toFixed(1)} km)</span></p>
            </div>
            <div style="flex:1; background: #7f8c8d; color: white; padding: 20px; border-radius: 10px;">
                <h4>Viajes Vacío</h4>
                <p style="font-size: 24px; font-weight: bold;">${totals.empCount} <span style="font-size: 14px;">(${totals.empDist.toFixed(1)} km)</span></p>
            </div>
        `;
        document.getElementById("btn-download").style.display = "block";
    };

    // Exportar a Excel (CSV)
    const downloadCSV = (data) => {
        let csv = "Vehiculo,Estado,Inicio,Duracion(min),Distancia(km)\n";
        data.forEach(r => {
            csv += `${r.vehicle},${r.occupied ? 'Ocupado' : 'Vacio'},${r.start},${r.duration},${r.distance}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('download', `Informe_Ocupacion_${document.getElementById("date-selector").value}.csv`);
        a.click();
    };

    return {
        initialize: function (api, state, callback) { callback(); },
        focus: function (api, state) {
            let lastData = [];
            document.getElementById("btn-refresh").onclick = async () => {
                const date = document.getElementById("date-selector").value;
                if (!date) return alert("Selecciona una fecha");
                lastData = await fetchAllData(date);
                renderUI(lastData);
            };
            document.getElementById("btn-download").onclick = () => downloadCSV(lastData);
        },
        blur: function () {}
    };
};