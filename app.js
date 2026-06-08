// --- CONFIGURATION ---
const positionsMap = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const positionBadgeClasses = {
    GKP: 'bg-warning text-dark',
    DEF: 'bg-success text-white',
    MID: 'bg-primary text-white',
    FWD: 'bg-danger text-white'
};

function getPositionBadge(position) {
    const badgeClass = positionBadgeClasses[position] || 'bg-secondary text-white';
    return `<span class="badge ${badgeClass}">${position}</span>`;
}

let allPlayers = [];
let watchPlayers = JSON.parse(localStorage.getItem("myWatchlist")) || [];
let currentPage = 1;
let currentFilter = 'ALL';
let fixturesData = [];
let manualFixturesData = [];
let fixturesFilterType = 'all';
let fixturesFilterName = 'all';
const pageSize = 10;

// --- STARTUP ---
window.onload = async () => {
    updateGameweekTitle();
    // 1. If on Home Page
    if (document.getElementById("player-table-body")) {
        await initializeScout();
        document.getElementById('player-search')?.addEventListener('input', () => {
            currentPage = 1;
            renderPage();
        });
    }

    // 2. If on Watchlist Page
    if (document.getElementById("watchlist-table-body")) {
        await initializeScout();
        renderWatchlist();
    }

    // 2b. If on Recommendations page
    if (document.getElementById("recommended-container")) {
        await loadRecommendedPage();
    }

    // 3. If on the home page
    if (document.getElementById("overview")) {
        await loadOverview();
    }
};
// --- DATA FETCHING ---
async function initializeScout() {
    try {
        const response = await fetch('/api/players');
        if (!response.ok) throw new Error('Backend API not available');
        const data = await response.json();

        allPlayers = data.map(p => ({
            ...p,
            fix: p.nextFixture || 'TBD',
            pts: p.total_points || p.pts || 0,
            price: typeof p.price === 'number' ? p.price.toFixed(1) : p.price,
            form: parseFloat(p.form) || 0,
            goals_scored: p.goals_scored || 0,
            assists: p.assists || 0,
            clean_sheets: p.clean_sheets || 0,
            yellow_cards: p.yellow_cards || 0,
            minutes: p.minutes || 0,
            bonus: p.bonus || 0,
            predictedPoints: p.predictedPoints || 0,
            captainScore: p.captainScore || 0,
            selected_by_percent: p.selected_by_percent || p.selectedByPercent || 0
        }));

        updateRecommendations(allPlayers);
        updateCaptainPicks(allPlayers);
        renderPage();
        loadPredictionWidgets();
        await loadLiveHealthBadge();
    } catch (error) {
        console.warn('Backend API unavailable — falling back to local JSON.', error);
        try {
            const response = await fetch('static_data.json');
            const data = await response.json();
            const teamsMap = {};
            data.teams.forEach(t => teamsMap[t.id] = t.name);

            allPlayers = data.elements.map(p => ({
                name: p.web_name,
                pos: positionsMap[p.element_type] || 'N/A',
                team: teamsMap[p.team] || 'Unknown',
                pts: p.total_points || 0,
                fix: p.ep_next ? `${p.ep_next} xP` : 'TBD',
                price: (p.now_cost / 10).toFixed(1),
                form: parseFloat(p.form) || 0,
                goals_scored: p.goals_scored || 0,
                assists: p.assists || 0,
                clean_sheets: p.clean_sheets || 0,
                yellow_cards: p.yellow_cards || 0,
                minutes: p.minutes || 0,
                bonus: p.bonus || 0,
                predictedPoints: parseFloat(p.ep_next) || parseFloat(p.ep_this) || 0,
                captainScore: (parseFloat(p.ep_next) || parseFloat(p.ep_this) || 0) * 1.05
            }));

            updateRecommendations(allPlayers);
            updateCaptainPicks(allPlayers);
            renderPage();
            await loadLiveHealthBadge();
        } catch (fallbackError) {
            console.error('Static data fallback failed:', fallbackError);
            await loadLiveHealthBadge();
        }
    }
}

async function loadPredictionWidgets() {
    const container = document.getElementById('recommendation-container');
    const captainContainer = document.getElementById('captain-container');
    if (!container || !captainContainer) return;

    try {
        const response = await fetch('/api/predictions');
        if (!response.ok) throw new Error('Prediction endpoint failed');
        const data = await response.json();
        const liveStatus = data.summary?.liveMode ? 'Live data from FPL API' : 'Local fallback mode';
        const statusBadge = data.summary?.liveMode ? 'bg-success' : 'bg-secondary';

        container.innerHTML = `
            <div class="mb-3">
                <span class="badge ${statusBadge}">${liveStatus}</span>
            </div>
        ` + data.bestTransfers.map(player => `
            <div class="d-flex justify-content-between align-items-center border-bottom p-2">
                <div>
                    <div class="fw-semibold">${player.name}</div>
                    <small class="text-muted">${player.team} · ${player.pos}</small>
                </div>
                <div class="text-end">
                    <div class="badge bg-primary">${player.predictedPoints} xP</div>
                    <div class="small text-muted">£${player.price}m</div>
                </div>
            </div>
        `).join('');

        captainContainer.innerHTML = data.captainPicks.map(player => `
            <div class="col-md-4">
                <div class="card bg-dark text-white p-3 text-center">
                    <h6 class="mb-1">${player.name}</h6>
                    <small class="d-block mb-2 text-white-50">${player.team} · ${player.pos}</small>
                    <span class="badge bg-warning text-dark">${player.captainScore}</span>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.warn('Could not render prediction widgets:', error);
        const fallback = await loadFallbackPredictions();
        if (fallback) {
            container.innerHTML = `
                <div class="mb-3">
                    <span class="badge bg-secondary">Fallback local data</span>
                    <p class="small text-muted mt-2">Predictions are shown from local fallback data.</p>
                </div>
            ` + fallback.bestTransfers.map(player => `
                <div class="d-flex justify-content-between align-items-center border-bottom p-2">
                    <div>
                        <div class="fw-semibold">${player.name}</div>
                        <small class="text-muted">${player.team} · ${player.pos}</small>
                    </div>
                    <div class="text-end">
                        <div class="badge bg-primary">${player.predictedPoints} xP</div>
                        <div class="small text-muted">£${player.price}m</div>
                    </div>
                </div>
            `).join('');

            captainContainer.innerHTML = fallback.captainPicks.map(player => `
                <div class="col-md-4">
                    <div class="card bg-dark text-white p-3 text-center">
                        <h6 class="mb-1">${player.name}</h6>
                        <small class="d-block mb-2 text-white-50">${player.team} · ${player.pos}</small>
                        <span class="badge bg-warning text-dark">${player.captainScore.toFixed(1)}</span>
                    </div>
                </div>
            `).join('');
            return;
        }
        container.innerHTML = `<div class="text-muted">Predictions are unavailable right now.</div>`;
    }
}

async function loadLiveHealthBadge() {
    const badge = document.getElementById('live-health-badge');
    if (!badge) return;

    try {
        const response = await fetch('/api/health');
        if (!response.ok) {
            throw new Error('Health API did not respond');
        }
        const data = await response.json();
        badge.textContent = data.liveMode ? 'LIVE DATA' : 'FALLBACK MODE';
        badge.className = data.liveMode ? 'badge bg-success' : 'badge bg-secondary';
        badge.title = `Source: ${data.source}`;
    } catch (error) {
        badge.textContent = 'OFFLINE';
        badge.className = 'badge bg-danger';
        badge.title = 'Unable to reach backend health status';
    }
}

async function loadRecommendedPage() {
    await loadLiveHealthBadge();

    const container = document.getElementById('recommended-container');
    if (!container) return;

    try {
        const response = await fetch('/api/predictions');
        if (!response.ok) throw new Error('Prediction endpoint failed');
        const data = await response.json();

        const statusBadge = data.summary?.liveMode ? 'bg-success' : 'bg-secondary';
        const healthText = data.summary?.liveMode ? 'Live data from FPL API' : 'Fallback local data';

        container.innerHTML = `
            <div class="mb-4">
                <span class="badge ${statusBadge}">${healthText}</span>
            </div>
            <div class="row g-3 mb-4">
                <div class="col-md-6">
                    <div class="card p-3">
                        <h5>Top Transfer Picks</h5>
                        ${data.bestTransfers.map(player => `
                            <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                                <div>
                                    <strong>${player.name}</strong><br>
                                    <small class="text-muted">${player.team} · ${player.pos}</small>
                                </div>
                                <div class="text-end">
                                    <div class="badge bg-primary">${player.predictedPoints} xP</div>
                                    <div class="small text-muted">£${player.price}m</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card p-3">
                        <h5>Captain Shortlist</h5>
                        ${data.captainPicks.map(player => `
                            <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                                <div>
                                    <strong>${player.name}</strong><br>
                                    <small class="text-muted">${player.team} · ${player.pos}</small>
                                </div>
                                <div class="text-end">
                                    <span class="badge bg-warning text-dark">${player.captainScore}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
    } catch (error) {
        console.warn('Could not load recommended page:', error);
        const fallback = await loadFallbackPredictions();
        if (fallback) {
            renderRecommendationFallback(container, fallback, 'Using local fallback data because live predictions are unavailable.');
            return;
        }
        container.innerHTML = `<div class="alert alert-warning">Unable to load recommended transfers at the moment.</div>`;
    }
}

async function loadFallbackPredictions() {
    try {
        const response = await fetch('static_data.json');
        if (!response.ok) throw new Error('Local data unavailable');
        const data = await response.json();
        const teamsMap = data.teams.reduce((acc, team) => {
            acc[team.id] = team.name;
            return acc;
        }, {});
        const players = data.elements.map(p => ({
            id: p.id,
            name: p.web_name,
            pos: positionsMap[p.element_type] || 'N/A',
            team: teamsMap[p.team] || 'Unknown',
            price: (p.now_cost / 10).toFixed(1),
            predictedPoints: parseFloat(p.ep_next) || parseFloat(p.ep_this) || 0,
            captainScore: (parseFloat(p.ep_next) || parseFloat(p.ep_this) || 0) * 1.05,
            nextFixture: p.ep_next ? `${p.ep_next} xP` : 'TBD'
        }));

        const sortedByPrediction = players.sort((a, b) => b.predictedPoints - a.predictedPoints);
        const sortedByCaptain = players.sort((a, b) => b.captainScore - a.captainScore);

        return {
            bestTransfers: sortedByPrediction.slice(0, 8),
            captainPicks: sortedByCaptain.slice(0, 5),
            summary: { liveMode: false }
        };
    } catch (error) {
        console.warn('Fallback predictions failed:', error);
        return null;
    }
}

function renderRecommendationFallback(container, data, message) {
    const statusBadge = 'bg-secondary';
    container.innerHTML = `
        <div class="mb-4">
            <span class="badge ${statusBadge}">Fallback local data</span>
            <p class="small text-muted mt-2">${message}</p>
        </div>
        <div class="row g-3 mb-4">
            <div class="col-md-6">
                <div class="card p-3">
                    <h5>Top Transfer Picks</h5>
                    ${data.bestTransfers.map(player => `
                        <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                            <div>
                                <strong>${player.name}</strong><br>
                                <small class="text-muted">${player.team} · ${player.pos}</small>
                            </div>
                            <div class="text-end">
                                <div class="badge bg-primary">${player.predictedPoints} xP</div>
                                <div class="small text-muted">£${player.price}m</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="col-md-6">
                <div class="card p-3">
                    <h5>Captain Shortlist</h5>
                    ${data.captainPicks.map(player => `
                        <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                            <div>
                                <strong>${player.name}</strong><br>
                                <small class="text-muted">${player.team} · ${player.pos}</small>
                            </div>
                            <div class="text-end">
                                <span class="badge bg-warning text-dark">${player.captainScore.toFixed(1)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

// --- HOME PAGE RENDER ---
window.renderHomepage = (playersToRender) => {
    const tbody = document.getElementById("player-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    
    playersToRender.forEach((p) => {
        // Check if player is already in watchlist to set yellow color
        const isWatched = watchPlayers.find(w => w.name === p.name);
        const starClass = isWatched ? "bi-star-fill active" : "bi-star";
        
        tbody.innerHTML += `<tr>
            <td>
    <span onclick="showDetails('${p.name}')" style="cursor:pointer; color:#000; text-decoration:underline;">
        <strong>${p.name}</strong>
    </span>
</td>
            <td>${getPositionBadge(p.pos)}</td>
            <td>${p.team}</td>
            <td>${p.pts}</td>
            <td class="text-center">
                <button class="btn btn-sm btn-outline-secondary p-1 ${isWatched ? 'active-star' : ''}" onclick="toggleWatchlist(this, '${p.name}')" aria-label="Toggle watchlist for ${p.name}">
                    <i class="bi ${starClass} fw-bold"></i>
                </button>
            </td>
        </tr>`;
    });
};

function renderPage() {
    // 1. Safely get the search input
    const searchElement = document.getElementById('player-search');
    const searchTerm = searchElement ? searchElement.value.toLowerCase() : "";
    
    let filtered = allPlayers.filter(p => 
        p.name.toLowerCase().includes(searchTerm) &&
        (currentFilter === 'ALL' || p.pos === currentFilter)
    );
    
    const start = (currentPage - 1) * pageSize;
    renderHomepage(filtered.slice(start, start + pageSize));

    // 2. THE FIX: Add safety check for 'page-info'
    const pageInfo = document.getElementById("page-info");
    if (pageInfo) {
        pageInfo.innerText = `Page ${currentPage}`;
    }
}

// --- WATCHLIST LOGIC ---
window.addToWatchlist = (name) => {
    const player = allPlayers.find(p => p.name === name);
    if (player && !watchPlayers.find(p => p.name === name)) {
        watchPlayers.push(player);
        localStorage.setItem("myWatchlist", JSON.stringify(watchPlayers));
        alert(name + " added to Watchlist!");
    }
};

window.deleteFromWatchlist = (playerName, event) => {
    if (event) event.preventDefault();
    let watchlist = JSON.parse(localStorage.getItem('myWatchlist')) || [];
    watchlist = watchlist.filter(p => p.name !== playerName);
    localStorage.setItem('myWatchlist', JSON.stringify(watchlist));
    watchPlayers = JSON.parse(localStorage.getItem('myWatchlist')) || [];
    renderWatchlist();
    updateAnalysis();
};

// --- FILTERS & PAGINATION ---
window.setFilter = (position, event) => {
    currentFilter = position;
    currentPage = 1;
    renderPage();

    // 1. Reset all buttons to the "outline" look
    document.querySelectorAll('.btn-filter').forEach(btn => {
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline-secondary');
    });

    // 2. Turn only the clicked button "blue" (active)
    if (event) {
        event.target.classList.add('btn-primary');
        event.target.classList.remove('btn-outline-secondary');
    }
};

window.changePage = (direction) => {
    currentPage = Math.max(1, currentPage + direction);
    renderPage();
};
window.toggleWatchlist = (btnElement, name) => {
    const player = allPlayers.find(p => p.name === name);
    const index = watchPlayers.findIndex(p => p.name === name);
    
    const icon = btnElement.querySelector('i');
    
    if (index === -1) {
        // Add to list
        watchPlayers.push(player);
        icon.className = "bi bi-star-fill";
        btnElement.classList.add("active-star");
    } else {
        // Remove from list
        watchPlayers.splice(index, 1);
        icon.className = "bi bi-star";
        btnElement.classList.remove("active-star");
    }
    
    localStorage.setItem("myWatchlist", JSON.stringify(watchPlayers));
};
window.showDetails = (name) => {
    const rawPlayer = allPlayers.find(p => p.name === name);
    if (!rawPlayer) {
        console.log("Player not found:", name);
        return;
    }

    // Set content
    document.getElementById("playerName").innerText = rawPlayer.name;
    document.getElementById("playerDetails").innerHTML = `
        <ul class="list-group">
            <li class="list-group-item"><strong>Goals Scored:</strong> ${rawPlayer.goals_scored || 0}</li>
            <li class="list-group-item"><strong>Assists:</strong> ${rawPlayer.assists || 0}</li>
            <li class="list-group-item"><strong>Clean Sheets:</strong> ${rawPlayer.clean_sheets || 0}</li>
            <li class="list-group-item"><strong>Yellow Cards:</strong> ${rawPlayer.yellow_cards || 0}</li>
            <li class="list-group-item"><strong>Appearances:</strong> ${Math.floor(rawPlayer.minutes / 90) || 0}</li>
            <li class="list-group-item"><strong>Bonus Points:</strong> ${rawPlayer.bonus || 0}</li>
            <li class="list-group-item"><strong>Total Points:</strong> ${rawPlayer.pts || 0}</li>
        </ul>
    `;

    // --- CRITICAL FIX FOR BOOTSTRAP 5 ---
    const modalElement = document.getElementById('playerModal');
    const myModal = new bootstrap.Modal(modalElement);
    myModal.show();
};
function renderStatsPage() {
    const tableBody = document.getElementById("stats-table-body");
    tableBody.innerHTML = allPlayers.map(p => `
        <tr>
            <td>${p.name}</td>
            <td>${p.pos}</td>
            <td>${p.team}</td>
            <td>${p.total_points || 0}</td>
        </tr>
    `).join('');
}
async function updateGameweekTitle() {
    const titleElement = document.getElementById("gameweek-title");
    
    // 1. Safety check: If the element doesn't exist, stop immediately
    if (!titleElement) return;

    try {
        const response = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
        const data = await response.json();
        const currentEvent = data.events.find(e => e.is_current === true);
        const gwNumber = currentEvent ? currentEvent.id : "Latest";
        
        titleElement.innerText = `Gameweek ${gwNumber} Predictions`;
    } catch (error) {
        // 2. Handle the error gracefully without stopping the script
        console.warn("FPL API error (this is okay):", error);
        titleElement.innerText = "Predictions"; 
    }
}
function getBestTransfers(allPlayers) {
    // 1. Sort by form and potential (simple example)
    return allPlayers
        .sort((a, b) => (b.form * 1.5 + b.total_points / 10) - (a.form * 1.5 + a.total_points / 10))
        .slice(0, 5); // Get the top 5 recommended players
}

// Then, in your render function, create a new section:
function updateRecommendations(allPlayers) {
    const container = document.getElementById("recommendation-container");

    if (!container) {
        return;
    }

    const topPicks = allPlayers
        .sort((a, b) => (b.predictedPoints || 0) - (a.predictedPoints || 0))
        .slice(0, 5);

    container.innerHTML = topPicks.map(p => `
        <div class="d-flex justify-content-between align-items-center border-bottom p-2">
            <div>
                <div class="fw-semibold">${p.name}</div>
                <small class="text-muted">${p.team} · ${p.pos}</small>
            </div>
            <div class="text-end">
                <div class="badge bg-primary">${p.predictedPoints.toFixed(1)} xP</div>
                <div class="small text-muted">£${p.price}m</div>
            </div>
        </div>
    `).join('');
}
function updateCaptainPicks(allPlayers) {
    const container = document.getElementById("captain-container");
    if (!container) {
        return;
    }

    const topCaptains = allPlayers
        .sort((a, b) => (b.captainScore || 0) - (a.captainScore || 0))
        .slice(0, 3);
    
    container.innerHTML = topCaptains.map(p => `
        <div class="col-md-4">
            <div class="card bg-dark text-white p-3 text-center">
                <h6 class="mb-1">${p.name}</h6>
                <small class="d-block text-white-50 mb-2">${p.team} · ${p.pos}</small>
                <span class="badge bg-warning text-dark">${p.captainScore.toFixed(1)}</span>
            </div>
        </div>
    `).join('');
}
function addToWatchlist(player) {
    let watchlist = JSON.parse(localStorage.getItem('myWatchlist')) || [];
    // Check if player is already there
    if (!watchlist.find(p => p.id === player.id)) {
        watchlist.push(player);
        localStorage.setItem('myWatchlist', JSON.stringify(watchlist));
        updateAnalysis(); // Run the calculation whenever list changes
    }
}
function updateAnalysis() {
    const watchlist = JSON.parse(localStorage.getItem('myWatchlist')) || [];
    
    const totalBudget = watchlist.reduce((sum, p) => {
        const price = parseFloat(p.price.replace('£', '').replace('m', ''));
        return sum + (isNaN(price) ? 0 : price);
    }, 0);

    const totalPoints = watchlist.reduce((sum, p) => {
        // IMPORTANT: Change 'predictedPoints' to match the property in your data!
        // Based on your table, try: p.total_points or p.points
        const val = parseFloat(p.predictedPoints || p.points || p.total_points || 0);
        return sum + val;
    }, 0);
    
    const avgPoints = watchlist.length > 0 ? (totalPoints / watchlist.length) : 0;

    // Direct DOM updates
    document.getElementById('total-budget').innerText = `£${totalBudget.toFixed(1)}m`;
    document.getElementById('avg-points').innerText = `${avgPoints.toFixed(1)} pts`;
    
    // Update player count too
    const countEl = document.getElementById('watched-count');
    if (countEl) countEl.innerText = `${watchlist.length} Players Watched`;
}

function renderWatchlist() {
    const watchlist = JSON.parse(localStorage.getItem('myWatchlist')) || [];
    const container = document.getElementById('watchlist-table-body'); // MUST match your HTML ID

    if (container) {
        container.innerHTML = watchlist.map(player => `
            <tr>
                <td>
                    <strong>${player.name}</strong><br>
                    <small class="text-muted">${player.pos || ''} | ${player.team || ''}</small>
                </td>
                <td>£${player.price}</td>
                <td>${player.form}</td>
                <td>${player.pts || player.total_points || player.predictedPoints || 0}</td>
                <td class="text-center">
                    <button type="button" class="btn btn-sm btn-danger delete-watchlist-btn" data-player-name="${player.name}" aria-label="Delete ${player.name}">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }
}
// Run it when the page loads
// Paste the new block here:
document.addEventListener('DOMContentLoaded', () => {
    // 1. Check if we are on the Watchlist page
    const watchlistTable = document.getElementById('watchlist-table-body');
    
    // 2. If we are on the Watchlist page, run the render and the analysis
    if (watchlistTable) {
        renderWatchlist();
        updateAnalysis();
        watchlistTable.addEventListener('click', (event) => {
            const button = event.target.closest('button.delete-watchlist-btn');
            if (!button) return;
            const playerName = button.dataset.playerName;
            if (playerName) {
                deleteFromWatchlist(playerName);
            }
        });
    }
});