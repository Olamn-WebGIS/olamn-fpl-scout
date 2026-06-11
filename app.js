// --- CONFIGURATION ---
const positionsMap = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const positionBadgeClasses = {
    GKP: 'bg-warning text-dark',
    DEF: 'bg-success text-white',
    MID: 'bg-primary text-white',
    FWD: 'bg-danger text-white'
};

const API_BASE_URL = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:3000'
    : 'https://olamn-fpl-scout.vercel.app';
const MANAGER_STORAGE_KEY = 'fplManagerId';
const PLAYER_IMAGE_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23e9ecef'/%3E%3Ccircle cx='20' cy='14' r='8' fill='%23909ca3'/%3E%3Cpath d='M11 30c1.5-6 7.5-8 9-8s7.5 2 9 8' fill='none' stroke='%23909ca3' stroke-width='2'/%3E%3C/svg%3E";
let managerSyncActive = false;

// Global error handler to capture script/resource causing SyntaxError
window.addEventListener('error', (e) => {
    try {
        console.error('Global error captured:', e.message, 'source:', e.filename || e.target?.src || '(inline)', 'lineno:', e.lineno, 'col:', e.colno);
    } catch (err) {
        console.error('Error logging failed', err);
    }
});
window.addEventListener('unhandledrejection', (e) => {
    try { console.error('Unhandled promise rejection:', e.reason); } catch (err) { console.error(err); }
});

function getPositionBadge(position) {
    const badgeClass = positionBadgeClasses[position] || 'bg-secondary text-white';
    return `<span class="badge ${badgeClass}">${position}</span>`;
}

function getSavedManagerId() {
    return localStorage.getItem(MANAGER_STORAGE_KEY) || '';
}

function saveManagerId(id) {
    localStorage.setItem(MANAGER_STORAGE_KEY, id);
}

function clearManagerId() {
    localStorage.removeItem(MANAGER_STORAGE_KEY);
}

let photoDebugLogged = false;

function getPlayerPhotoUrl(player) {
    if (!player) return null;
    if (player.photoUrl) return player.photoUrl;

    const sourcePhoto = player.photo || player.opta_code || player.id || player.code;
    if (!sourcePhoto && sourcePhoto !== 0) {
        if (!photoDebugLogged) {
            console.warn('Player missing photo source:', player);
            photoDebugLogged = true;
        }
        return null;
    }

    const sourceString = String(sourcePhoto).trim();
    if (!sourceString) {
        if (!photoDebugLogged) {
            console.warn('Player has empty photo source:', player);
            photoDebugLogged = true;
        }
        return null;
    }

    // Already a full URL
    if (/^https?:\/\//i.test(sourceString)) {
        return sourceString;
    }

    // Normalize IDs like "154561.jpg", "p154561.jpg", "154561", "p154561"
    let photoId = sourceString.replace(/^p/i, '').replace(/\.(jpg|png)$/i, '');
    if (!/^[0-9]+$/.test(photoId)) {
        if (!photoDebugLogged) {
            console.warn('Player photo source could not be normalized:', player);
            photoDebugLogged = true;
        }
        return null;
    }

    return `https://resources.premierleague.com/premierleague/photos/players/110x140/p${photoId}.png`;
}

function getPlayerPhotoSrc(player) {
    const primary = getPlayerPhotoUrl(player);
    if (primary) return primary;

    const sourcePhoto = player.photo || player.opta_code || player.id || player.code;
    if (!sourcePhoto && sourcePhoto !== 0) return PLAYER_IMAGE_FALLBACK;

    const photoId = String(sourcePhoto).trim().replace(/^p/i, '').replace(/\.(jpg|png)$/i, '');
    if (/^[0-9]+$/.test(photoId)) {
        return `https://resources.premierleague.com/premierleague/photos/players/110x140/p${photoId}.png`;
    }
    return PLAYER_IMAGE_FALLBACK;
}

function handlePlayerImageError(img) {
    if (!img) return;
    const retryPhase = parseInt(img.dataset.retryPhase || '0', 10);
    const source = img.dataset.photoSource || img.dataset.photoId || '';
    const photoId = String(source).trim().replace(/^p/i, '').replace(/\.(jpg|png)$/i, '');

    if (retryPhase === 0 && /^[0-9]+$/.test(photoId)) {
        img.dataset.retryPhase = '1';
        img.src = `https://resources.premierleague.com/premierleague/photos/players/250x250/p${photoId}.png`;
        return;
    }

    img.onerror = null;
    img.src = PLAYER_IMAGE_FALLBACK;
}

function showManagerSyncMessage(message, isError = false) {
    const messageElement = document.getElementById('manager-sync-message');
    if (!messageElement) return;
    messageElement.textContent = message;
    messageElement.className = isError ? 'small text-danger' : 'small text-success';
}

function renderManagerProfile(managerData) {
    const profileCard = document.getElementById('manager-profile-card');
    const teamName = document.getElementById('manager-team-name');
    const managerName = document.getElementById('manager-profile-name');
    const chipSummary = document.getElementById('manager-chip-summary');
    if (!profileCard || !teamName || !managerName || !chipSummary) return;

    profileCard.classList.remove('d-none');
    teamName.textContent = managerData.managerProfile.team_name || managerData.managerProfile.teamName || 'Unknown team';
    managerName.textContent = managerData.managerProfile.name || `${managerData.managerProfile.player_first_name || ''} ${managerData.managerProfile.player_last_name || ''}`.trim() || 'FPL manager';
    chipSummary.textContent = managerData.managerProfile.remainingChips.length
        ? `Unused chips: ${managerData.managerProfile.remainingChips.join(', ')}`
        : 'No chips remaining';
    
    // Fetch and display manager's squad
    fetchAndDisplayManagerSquad(managerData.managerProfile.id || managerData.managerProfile.entry_id);
}

async function fetchAndDisplayManagerSquad(managerId) {
    try {
        const squadGrid = document.getElementById('manager-squad-grid');
        if (!squadGrid) return;
        
        // FIX 1: Declare the proxy variable explicitly inside the function
        const proxy = "https://api.allorigins.win/get?url=";
        
        // 1. Fetch Master Data
        const bootstrapUrl = "https://fantasy.premierleague.com/api/bootstrap-static/";
        const bootstrapResponse = await fetch(proxy + encodeURIComponent(bootstrapUrl));
        const bootstrapData = await bootstrapResponse.json();
        
        // FIX 2: Check if contents exist before parsing
        if (!bootstrapData.contents) throw new Error("Proxy failed to return data");
        const bootstrap = JSON.parse(bootstrapData.contents);
        
        const currentGW = bootstrap.events.find(e => e.is_current).id;
        const players = bootstrap.elements;
        
        // 2. Fetch manager's picks
        const picksResponse = await fetch(`/api/fpl?managerId=${managerId}&gameweek=${currentGW}`);
        const picksData = await picksResponse.json();
        
        if (!picksData.contents) throw new Error("Could not fetch picks");
        const picks = JSON.parse(picksData.contents);
        
        // 3. Render squad
        const positionNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const positionColors = { 1: '#FFD700', 2: '#FF6B6B', 3: '#4ECDC4', 4: '#45B7D1' };
        
        const squadHtml = (picks.picks || []).map(pick => {
            const player = players.find(p => p.id === pick.element);
            const posName = positionNames[player?.element_type] || 'U';
            const isBench = pick.position > 11;
            
            return `
                <div class="player-card" style="opacity: ${isBench ? 0.6 : 1}; border-left: 3px solid ${positionColors[player?.element_type] || '#ccc'}; border-radius: 14px; padding: 0.75rem; text-align: center; background: #f8fbff; border: 1px solid rgba(15, 76, 129, 0.1);">
                    <div class="player-name" style="font-size: 0.85rem; font-weight: 600;">${player?.second_name || 'Unknown'}</div>
                    <div style="font-size: 0.75rem; color: #6f8294;">${posName}${isBench ? ' (B)' : ''}</div>
                </div>
            `;
        }).join('');
        
        squadGrid.innerHTML = squadHtml;
        
    } catch (error) {
        console.error('Error loading manager squad:', error);
        document.getElementById('manager-squad-grid').innerHTML = '<p>Unable to load squad. Please try again later.</p>';
    }
}
function setupManagerSyncHandlers() {
    const input = document.getElementById('manager-id-input');
    const button = document.getElementById('manager-sync-button');
    if (!button || !input) return;

    button.addEventListener('click', async () => {
        const managerId = input.value.trim();
        if (!managerId) {
            showManagerSyncMessage('Enter your FPL manager ID first.', true);
            return;
        }
        showManagerSyncMessage('Syncing manager data...', false);
        button.disabled = true;
        button.textContent = 'Syncing...';
        try {
            await handleManagerSync(managerId);
        } catch (error) {
            console.error('Manager sync failed:', error);
        } finally {
            button.disabled = false;
            button.textContent = 'Sync';
        }
    });
}

async function handleManagerSync(managerId) {
    try {
        const managerData = await loadManagerData(managerId);
        managerSyncActive = true;
        saveManagerId(managerId);
        showManagerSyncMessage('Manager synced successfully.', false);
        renderManagerProfile(managerData);
        renderManagerRecommendations(managerData);
        return managerData;
    } catch (error) {
        managerSyncActive = false;
        showManagerSyncMessage(`Unable to sync manager: ${error.message}`, true);
        loadPredictionWidgets();
        throw error;
    }
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
    const savedManagerId = getSavedManagerId();

    // 1. If on Home Page
    if (document.getElementById("player-table-body")) {
        await initializeScout();
        setupManagerSyncHandlers();
        if (savedManagerId) {
            const managerInput = document.getElementById('manager-id-input');
            if (managerInput) managerInput.value = savedManagerId;
            await handleManagerSync(savedManagerId);
        } else {
            loadPredictionWidgets();
        }
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
        const response = await fetch(`${API_BASE_URL}/api/players`);
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

        // Render player table and load health badge; prediction widgets are loaded separately.
        renderPage();
        await loadLiveHealthBadge();
    } catch (error) {
        console.warn('Backend API unavailable — falling back to local JSON.', error);
        try {
            const response = await fetch('static_data.json');
            const data = await response.json();
            const teamsMap = {};
            data.teams.forEach(t => teamsMap[t.id] = t.name);

            allPlayers = data.elements.map(p => ({
                id: p.id,
                photo: p.photo,
                opta_code: p.opta_code || p.code,
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

            // Render player table and load health badge; prediction widgets are loaded separately.
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
        const response = await fetch(`${API_BASE_URL}/api/predictions`);
        if (!response.ok) throw new Error('Prediction endpoint failed');
        const data = await response.json();
        const liveStatus = data.summary?.liveMode ? 'Live data from FPL API' : 'Local fallback mode';
        const statusBadge = data.summary?.liveMode ? 'bg-success' : 'bg-secondary';

        setTimeout(() => {
        container.innerHTML = `
            <div class="mb-3">
                <span class="badge ${statusBadge}">${liveStatus}</span>
            </div>
        ` + data.bestTransfers.map(player => `
            <div class="d-flex justify-content-between align-items-center border-bottom p-2">
                <div class="d-flex align-items-center">
                    <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                    <div>
                        <div class="fw-semibold">${player.name}</div>
                        <small class="text-muted">${player.team} · ${player.pos}</small>
                    </div>
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
                    <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;object-position:center top;margin-bottom:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                    <h6 class="mb-1">${player.name}</h6>
                    <small class="d-block mb-2 text-white-50">${player.team} · ${player.pos}</small>
                    <span class="badge bg-warning text-dark">${player.captainScore}</span>
                </div>
            </div>
        `).join('');
        }, 3000);
    } catch (error) {
        console.warn('Could not render prediction widgets:', error);
        const fallback = await loadFallbackPredictions();
        if (fallback) {
            setTimeout(() => {
            container.innerHTML = `
                <div class="mb-3">
                    <span class="badge bg-secondary">Fallback local data</span>
                    <p class="small text-muted mt-2">Predictions are shown from local fallback data.</p>
                </div>
            ` + fallback.bestTransfers.map(player => `
                <div class="d-flex justify-content-between align-items-center border-bottom p-2">
                    <div class="d-flex align-items-center">
                        <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                        <div>
                            <div class="fw-semibold">${player.name}</div>
                            <small class="text-muted">${player.team} · ${player.pos}</small>
                        </div>
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
                        <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;object-position:center top;margin-bottom:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                        <h6 class="mb-1">${player.name}</h6>
                        <small class="d-block mb-2 text-white-50">${player.team} · ${player.pos}</small>
                        <span class="badge bg-warning text-dark">${player.captainScore.toFixed(1)}</span>
                    </div>
                </div>
            `).join('');
            }, 3000);
            return;
        }
        setTimeout(() => {
        container.innerHTML = `<div class="text-muted">Predictions are unavailable right now.</div>`;
        }, 3000);
    }
}

async function loadManagerData(managerId) {
    const response = await fetch(`${API_BASE_URL}/api/manager/${managerId}`);
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(errorBody || 'Unable to load manager data');
    }
    return response.json();
}

function renderManagerRecommendations(managerData) {
    const container = document.getElementById('recommendation-container');
    const captainContainer = document.getElementById('captain-container');
    if (!container || !captainContainer || !managerData?.managerRecommendations) return;

    const recommendations = managerData.managerRecommendations;
    const transfers = recommendations.suggestedTransfers || [];
    const sells = recommendations.suggestedSells || [];
    const captainPicks = recommendations.captainPicks || [];
    const chipAdvice = recommendations.chipAdvice || {};

    setTimeout(() => {
        container.innerHTML = `
            <div class="mb-3">
                <span class="badge bg-success">FPL manager sync active</span>
                <p class="small text-muted mt-2">Personalized transfer and chip advice for your squad.</p>
            </div>
            <div class="card bg-light border-0 mb-3 p-3">
                <h6 class="mb-2">Transfer suggestions</h6>
                ${transfers.length ? transfers.map(player => `
                    <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                        <div class="d-flex align-items-center">
                            <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                            <div>
                                <strong>${player.name}</strong><br>
                                <small class="text-muted">${player.team} · ${player.pos}</small>
                            </div>
                        </div>
                        <div class="text-end">
                            <div class="badge bg-primary">${player.predictedPoints} xP</div>
                        </div>
                    </div>
                `).join('') : '<div class="text-muted small">No new transfers recommended at this time.</div>'}
            </div>
            <div class="card bg-light border-0 p-3">
                <h6 class="mb-2">Players to consider selling</h6>
                ${sells.length ? sells.map(player => `
                    <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                        <div class="d-flex align-items-center">
                                <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                            <div>
                                <strong>${player.name}</strong><br>
                                <small class="text-muted">${player.team} · ${player.pos}</small>
                            </div>
                        </div>
                        <div class="text-end">
                            <div class="badge bg-secondary">${player.predictedPoints} xP</div>
                        </div>
                    </div>
                `).join('') : '<div class="text-muted small">Your current squad is aligned with the top predictions.</div>'}
            </div>
            ${chipAdvice.summary ? `<div class="alert alert-info mt-3 py-2">${chipAdvice.summary}</div>` : ''}
        `;

        captainContainer.innerHTML = captainPicks.length ? captainPicks.map(player => `
            <div class="col-md-4">
                <div class="card bg-dark text-white p-3 text-center">
                    <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;object-position:center top;margin-bottom:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                    <h6 class="mb-1">${player.name}</h6>
                    <small class="d-block mb-2 text-white-50">${player.team} · ${player.pos}</small>
                    <span class="badge bg-warning text-dark">${player.captainScore}</span>
                </div>
            </div>
        `).join('') : '<div class="text-muted">No captain recommendations available yet.</div>';
    }, 3000);
}

async function loadLiveHealthBadge() {
    const badge = document.getElementById('live-health-badge');
    if (!badge) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/health`);
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
        const response = await fetch(`${API_BASE_URL}/api/predictions`);
        if (!response.ok) throw new Error('Prediction endpoint failed');
        const data = await response.json();

        const statusBadge = data.summary?.liveMode ? 'bg-success' : 'bg-secondary';
        const healthText = data.summary?.liveMode ? 'Live data from FPL API' : 'Fallback local data';

        setTimeout(() => {
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
                                <div class="d-flex align-items-center">
                                    <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                                    <div>
                                        <strong>${player.name}</strong><br>
                                        <small class="text-muted">${player.team} · ${player.pos}</small>
                                    </div>
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
                                <div class="d-flex align-items-center">
                                    <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                                    <div>
                                        <strong>${player.name}</strong><br>
                                        <small class="text-muted">${player.team} · ${player.pos}</small>
                                    </div>
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
        }, 3000);
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
            photo: p.photo,
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
                            <div class="d-flex align-items-center">
                                <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                                <div>
                                    <strong>${player.name}</strong><br>
                                    <small class="text-muted">${player.team} · ${player.pos}</small>
                                </div>
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
                            <div class="d-flex align-items-center">
                                <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                                <div>
                                    <strong>${player.name}</strong><br>
                                    <small class="text-muted">${player.team} · ${player.pos}</small>
                                </div>
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
                <div class="player-name-cell">
                    <img src="${getPlayerPhotoSrc(p)}" alt="${p.name}" class="player-avatar"
                        data-photo-source="${p.photo || p.opta_code || p.code || p.id || ''}"
                        data-photo-id="${p.id || ''}"
                        onerror="handlePlayerImageError(this)">
                    <span onclick="showDetails('${p.name}')" style="cursor:pointer; color:#000; text-decoration:underline;">
                        <strong>${p.name}</strong>
                    </span>
                </div>
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
    const captainTitleElement = document.getElementById("gameweek-title-captain");
    
    // 1. Safety check: If no elements exist, stop immediately
    if (!titleElement && !captainTitleElement) return;

    // Delay the fetch by 3 seconds
    setTimeout(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/predictions`);
            const data = await response.json();
            const currentEvent = data.summary?.currentEvent || null;
            const nextEvent = data.summary?.nextEvent || null;

            let displayText = 'Predictions for the next gameweek';
            if (nextEvent) {
                const currentId = currentEvent || Math.max(0, nextEvent - 1);
                displayText = `Predictions for Gameweek ${nextEvent} · Data updated to GW ${currentId}`;
            } else if (currentEvent) {
                displayText = `Predictions for Gameweek ${currentEvent} · Data updated to current GW`;
            }

            if (titleElement) titleElement.innerText = displayText;
            if (captainTitleElement) captainTitleElement.innerText = displayText;
        } catch (error) {
            // 2. Handle the error gracefully without stopping the script
            console.warn("FPL API error (this is okay):", error);
            const fallbackText = "Predictions for the next gameweek";
            if (titleElement) titleElement.innerText = fallbackText;
            if (captainTitleElement) captainTitleElement.innerText = fallbackText;
        }
    }, 3000);
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
                    <div class="d-flex align-items-center">
                        <img src="${getPlayerPhotoSrc(player)}" alt="${player.name}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;object-position:center top;margin-right:10px;" data-photo-source="${player.photo || player.opta_code || player.code || player.id || ''}" data-photo-id="${player.id || ''}" onerror="handlePlayerImageError(this)">
                        <div>
                            <strong>${player.name}</strong><br>
                            <small class="text-muted">${player.pos || ''} | ${player.team || ''}</small>
                        </div>
                    </div>
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
    // Log player image sources shortly after initial render to aid debugging
    setTimeout(() => {
        try { logPlayerImageSources(); } catch (e) { console.warn('logPlayerImageSources failed:', e); }
    }, 4000);
});

// Debug helper: log img.src values for likely player image elements
function logPlayerImageSources() {
    try {
        const selectors = [
            '#recommendation-container img',
            '#captain-container img',
            '#player-table-body img',
            '#watchlist-table-body img',
            '.card img'
        ];
        const imgs = Array.from(document.querySelectorAll(selectors.join(',')));
        if (!imgs.length) {
            console.info('LogPlayerImages: no player images found yet');
            return;
        }
        console.group('Player image sources');
        imgs.forEach(img => {
            const srcAttr = img.getAttribute('src');
            const src = img.src || srcAttr;
            if (srcAttr !== src) {
                console.info(`img alt="${img.alt || ''}" -> attribute=${srcAttr} final=${src}`);
            } else {
                console.info(`img alt="${img.alt || ''}" -> ${src}`);
            }
        });
        console.groupEnd();
    } catch (err) {
        console.warn('logPlayerImageSources error', err);
    }
}
async function spyOnRival(rivalManagerId, currentGW) {
    try {
        const response = await fetch(`/api/spy/?managerId=${rivalManagerId}&gameweek=${currentGW}`);
        const data = await response.json();
        
        console.log("Rival's team:", data.picks);
        // From here, you can compare 'data.picks' against your own squad!
        // e.g., check if they have the same captain or different players.
    } catch (error) {
        console.error("Spying failed:", error);
    }
}