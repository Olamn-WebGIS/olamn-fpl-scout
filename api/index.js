import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const STATIC_DATA_PATH = path.join(ROOT, 'static_data.json');
const LIVE_FPL_API_URL = process.env.LIVE_FPL_API_URL || process.env.FPL_API_URL || 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LIVE_FIXTURES_URL = process.env.LIVE_FIXTURES_URL || 'https://fantasy.premierleague.com/api/fixtures/';
const LIVE_CACHE_TTL = 60 * 1000;

let liveCache = { data: null, fetchedAt: 0, liveMode: false };
let fixtureCache = { data: null, fetchedAt: 0 };

const positionsMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');
}

async function loadStaticData() {
  const raw = await fs.readFile(STATIC_DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function loadLiveData() {
  const now = Date.now();
  if (liveCache.data && now - liveCache.fetchedAt < LIVE_CACHE_TTL) {
    return liveCache.data;
  }
  try {
    const response = await fetch(LIVE_FPL_API_URL);
    if (!response.ok) throw new Error(`Live data request failed: ${response.status}`);
    const json = await response.json();
    liveCache = { data: json, fetchedAt: now, liveMode: true };
    return json;
  } catch (error) {
    console.warn('Live FPL API fetch failed:', error.message);
    liveCache.liveMode = false;
    return null;
  }
}

async function loadLiveFixtures() {
  const now = Date.now();
  if (fixtureCache.data && now - fixtureCache.fetchedAt < LIVE_CACHE_TTL) {
    return fixtureCache.data;
  }
  try {
    const response = await fetch(LIVE_FIXTURES_URL);
    if (!response.ok) throw new Error(`Fixtures request failed: ${response.status}`);
    const json = await response.json();
    fixtureCache = { data: json, fetchedAt: now };
    return json;
  } catch (error) {
    console.warn('Live fixtures fetch failed:', error.message);
    return null;
  }
}

function buildTeamMap(sourceData) {
  const map = {};
  if (Array.isArray(sourceData?.teams)) {
    sourceData.teams.forEach(team => {
      map[team.id] = team.name || team.short_name || 'Unknown';
    });
  }
  return map;
}

function getNextFixtureForTeam(fixtures, teamId) {
  if (!Array.isArray(fixtures)) return null;
  const future = fixtures.filter(f => f.team_a === teamId || f.team_h === teamId);
  return future.length ? future[0] : null;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : parseFloat(value) || 0;
}

function parsePercent(value) {
  if (typeof value === 'string') return parseFloat(value.replace('%', '')) || 0;
  return safeNumber(value);
}

function computePredictionScore(player, fixtureInfo = null) {
  const epNext = safeNumber(player.ep_next) || safeNumber(player.ep_this) || safeNumber(player.points_per_game);
  const form = safeNumber(player.form);
  const selected = parsePercent(player.selected_by_percent);
  const totalPoints = safeNumber(player.total_points);
  const minutes = safeNumber(player.minutes);
  let score = epNext * 1.3 + form * 1.4 + Math.min(8, selected / 10) + Math.min(15, totalPoints / 20);
  score *= Math.min(1.0, Math.max(0.55, minutes / 2700));
  if (player.status && player.status.toLowerCase() !== 'a') score *= 0.55;
  if (fixtureInfo && typeof fixtureInfo.difficulty === 'number') {
    score += (6 - fixtureInfo.difficulty) * 0.22;
  }
  return Math.round(score * 10) / 10;
}

function computeCaptainScore(player, fixtureInfo = null) {
  const base = computePredictionScore(player, fixtureInfo);
  const selected = parsePercent(player.selected_by_percent);
  const goalThreat = safeNumber(player.goals_scored) * 0.25 + safeNumber(player.assists) * 0.2;
  let score = base * 1.16 + selected * 0.03 + goalThreat;
  if (fixtureInfo && typeof fixtureInfo.difficulty === 'number') {
    score += (6 - fixtureInfo.difficulty) * 0.14;
  }
  return Math.round(score * 10) / 10;
}

function normalizePlayer(player, teamMap, fixtureInfo = null) {
  const price = safeNumber(player.now_cost) / 10;
  const predictedPoints = computePredictionScore(player, fixtureInfo);
  const captainScore = computeCaptainScore(player, fixtureInfo);
  const opponentLabel = fixtureInfo ? `vs ${teamMap[fixtureInfo.opponent] || 'TBD'}` : '';
  const nextFixture = player.ep_next
    ? `${player.ep_next} xP ${opponentLabel}`.trim()
    : player.ep_this
    ? `${player.ep_this} xP ${opponentLabel}`.trim()
    : opponentLabel || 'TBD';

  const photoSource = player.photo || player.opta_code || player.id || '';
  const photoId = String(photoSource).replace(/^p/i, '').replace(/\.(jpg|png)$/i, '');
  const photoUrl = /^[0-9]+$/.test(photoId)
    ? `https://resources.premierleague.com/premierleague/photos/players/110x140/p${photoId}.png`
    : null;

  return {
    id: player.id,
    name: player.web_name || `${player.first_name || ''} ${player.second_name || ''}`.trim(),
    first_name: player.first_name,
    second_name: player.second_name,
    pos: positionsMap[player.element_type] || 'N/A',
    team: teamMap[player.team] || 'Unknown',
    team_id: player.team,
    photoUrl,
    photo: player.photo,
    opta_code: player.opta_code,
    pts: safeNumber(player.total_points),
    total_points: safeNumber(player.total_points),
    price,
    now_cost: safeNumber(player.now_cost),
    form: safeNumber(player.form),
    predictedPoints,
    captainScore,
    nextFixture,
    status: player.status,
    selected_by_percent: parsePercent(player.selected_by_percent),
    minutes: safeNumber(player.minutes),
    goals_scored: safeNumber(player.goals_scored),
    assists: safeNumber(player.assists),
    clean_sheets: safeNumber(player.clean_sheets),
    bonus: safeNumber(player.bonus),
    news: player.news || '',
    bps: safeNumber(player.bps),
    influence: safeNumber(player.influence),
    creativity: safeNumber(player.creativity),
    threat: safeNumber(player.threat),
    ict_index: safeNumber(player.ict_index),
    chance_of_playing: parsePercent(player.chance_of_playing_next_round) || parsePercent(player.chance_of_playing_this_round),
    ep_next: safeNumber(player.ep_next),
    ep_this: safeNumber(player.ep_this)
  };
}

function buildPredictions(players, liveMode = false, eventInfo = {}) {
  const sortedByPrediction = [...players].sort((a, b) => b.predictedPoints - a.predictedPoints);
  const sortedByCaptain = [...players].sort((a, b) => b.captainScore - a.captainScore);

  const bestTransfers = sortedByPrediction.slice(0, 8).map(p => ({
    id: p.id,
    name: p.name,
    pos: p.pos,
    team: p.team,
    price: p.price,
    predictedPoints: p.predictedPoints,
    nextFixture: p.nextFixture,
    status: p.status,
    news: p.news,
    photoUrl: p.photoUrl,
    photo: p.photo,
    opta_code: p.opta_code
  }));

  const captainPicks = sortedByCaptain.slice(0, 5).map(p => ({
    id: p.id,
    name: p.name,
    team: p.team,
    pos: p.pos,
    captainScore: p.captainScore,
    predictedPoints: p.predictedPoints,
    nextFixture: p.nextFixture,
    photoUrl: p.photoUrl,
    photo: p.photo,
    opta_code: p.opta_code
  }));

  const bestByPosition = ['GKP', 'DEF', 'MID', 'FWD'].reduce((acc, pos) => {
    acc[pos] = sortedByPrediction.filter(p => p.pos === pos).slice(0, 4);
    return acc;
  }, {});

  return {
    bestTransfers,
    captainPicks,
    bestByPosition,
    summary: {
      playerCount: players.length,
      topTransfer: bestTransfers[0] || null,
      topCaptain: captainPicks[0] || null,
      liveMode,
      currentEvent: eventInfo.currentEvent || null,
      nextEvent: eventInfo.nextEvent || null
    }
  };
}

function getManagerChipUsage(historyData) {
  const usedChips = new Set();
  if (Array.isArray(historyData?.current)) {
    historyData.current.forEach(event => {
      if (event?.chip) usedChips.add(event.chip);
    });
  }
  if (Array.isArray(historyData?.chips)) {
    historyData.chips.forEach(chip => {
      if (chip?.name) usedChips.add(chip.name);
    });
  }
  return Array.from(usedChips);
}

function getRemainingChips(usedChips) {
  const knownChips = ['wildcard', 'freehit', 'benchboost', '3xc'];
  return knownChips.filter(chip => !usedChips.includes(chip));
}

function buildManagerSquad(picks, playersById) {
  const squad = [];
  const bench = [];
  let captain = null;
  let viceCaptain = null;
  const activeChip = picks?.active_chip || null;

  if (!Array.isArray(picks?.picks)) {
    return { squad, bench, captain, viceCaptain, activeChip };
  }

  picks.picks.forEach(pick => {
    const player = playersById.get(pick.element);
    if (!player) return;
    const entry = {
      ...player,
      multiplier: pick.multiplier || 1,
      isCaptain: Boolean(pick.is_captain),
      isViceCaptain: Boolean(pick.is_vice_captain),
      position: pick.position || 0
    };
    if (pick.position > 11) {
      bench.push(entry);
    } else {
      squad.push(entry);
    }
    if (entry.isCaptain || entry.multiplier === 2) captain = entry;
    if (entry.isViceCaptain) viceCaptain = entry;
  });

  return { squad, bench, captain, viceCaptain, activeChip };
}

function computeChipAdvice(remainingChips, managerSquad, predictions) {
  const coach = [];
  const benchPoints = managerSquad.bench.reduce((sum, player) => sum + (player.predictedPoints || 0), 0);
  const weakPlayers = managerSquad.squad.filter(player => (player.predictedPoints || 0) < 4).length;
  const outOfSquadCount = predictions.bestTransfers.filter(player => !managerSquad.squad.some(p => p.id === player.id)).length;

  if (remainingChips.includes('3xc')) {
    coach.push('Triple Captain is available. Consider using it when your top captain has strong fixture value and a predicted score above 15.');
  }
  if (remainingChips.includes('wildcard')) {
    coach.push(weakPlayers >= 3
      ? 'Wildcard looks useful because several squad players have low predicted points.'
      : 'Save Wildcard for a future fixtures reset unless your squad requires a larger overhaul.'
    );
  }
  if (remainingChips.includes('freehit')) {
    coach.push(outOfSquadCount >= 4
      ? 'Free Hit is a good option when many high predicted players are outside your current squad.'
      : 'Keep Free Hit for a blank or double gameweek: it is best used when many regular starters are unavailable.'
    );
  }
  if (remainingChips.includes('benchboost')) {
    coach.push(benchPoints >= 11
      ? 'Bench Boost may pay off if your bench is already strong this week.'
      : 'Hold Bench Boost until your bench can contribute more than 10 points.'
    );
  }

  if (!coach.length) {
    coach.push('No chips available or no strong chip signal for the current week.');
  }

  return {
    summary: coach.join(' '),
    details: coach,
    remainingChips
  };
}

function buildManagerRecommendations(managerSquad, predictions) {
  const currentIds = new Set([...managerSquad.squad, ...managerSquad.bench].map(player => player.id));
  const topIds = new Set(predictions.bestTransfers.slice(0, 15).map(player => player.id));

  const suggestedTransfers = predictions.bestTransfers
    .filter(player => !currentIds.has(player.id))
    .slice(0, 4);

  const suggestedSells = managerSquad.squad
    .filter(player => !topIds.has(player.id))
    .slice(0, 4);

  return {
    suggestedTransfers,
    suggestedSells,
    captainPicks: predictions.captainPicks.slice(0, 5),
    topCaptain: predictions.captainPicks[0] || null
  };
}

export default async function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.url === '/api/players' && req.method === 'GET') {
      const sourceData = await loadLiveData() || await loadStaticData();
      const fixtures = await loadLiveFixtures();
      const teamMap = buildTeamMap(sourceData);
      const players = sourceData.elements.map(player => {
        const fixtureInfo = fixtures ? getNextFixtureForTeam(fixtures, player.team) : null;
        return normalizePlayer(player, teamMap, fixtureInfo);
      });

      const search = (req.query?.search || '').toString().toLowerCase();
      const position = (req.query?.position || '').toString().toUpperCase();

      let filtered = players;
      if (search) {
        filtered = filtered.filter(player => player.name.toLowerCase().includes(search) || player.team.toLowerCase().includes(search));
      }
      if (position && position !== 'ALL') {
        filtered = filtered.filter(player => player.pos === position);
      }

      return res.status(200).json(filtered.sort((a, b) => b.predictedPoints - a.predictedPoints));
    }

    if (req.url === '/api/predictions' && req.method === 'GET') {
      const sourceData = await loadLiveData() || await loadStaticData();
      const fixtures = await loadLiveFixtures();
      const teamMap = buildTeamMap(sourceData);
      const players = sourceData.elements.map(player => {
        const fixtureInfo = fixtures ? getNextFixtureForTeam(fixtures, player.team) : null;
        return normalizePlayer(player, teamMap, fixtureInfo);
      });
      const currentEvent = sourceData.current_event || (sourceData.events?.find(e => e.is_current)?.id) || (sourceData.events?.find(e => e.is_next)?.id) || 1;
      const nextEvent = sourceData.events?.find(e => e.is_next === true)?.id || sourceData.events?.find(e => e.id === ((currentEvent || 0) + 1))?.id || null;
      return res.status(200).json(buildPredictions(players, liveCache.liveMode, { currentEvent, nextEvent }));
    }

    if (req.url.startsWith('/api/manager/') && req.method === 'GET') {
      const managerId = req.url.split('/api/manager/')[1]?.split('?')[0];
      if (!managerId || !/^[0-9]+$/.test(managerId)) {
        return res.status(400).json({ message: 'Invalid manager ID.' });
      }

      try {
        const sourceData = await loadLiveData() || await loadStaticData();
        const fixtures = await loadLiveFixtures();
        const teamMap = buildTeamMap(sourceData);
        const players = sourceData.elements.map(player => {
          const fixtureInfo = fixtures ? getNextFixtureForTeam(fixtures, player.team) : null;
          return normalizePlayer(player, teamMap, fixtureInfo);
        });
        const playersById = new Map(players.map(player => [player.id, player]));
        const currentEvent = sourceData.current_event || (sourceData.events?.find(e => e.is_current)?.id) || (sourceData.events?.find(e => e.is_next)?.id) || 1;

        const profileResponse = await fetch(`https://fantasy.premierleague.com/api/entry/${managerId}/`);
        if (!profileResponse.ok) throw new Error('Unable to fetch manager profile.');
        const profileData = await profileResponse.json();

        const historyResponse = await fetch(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`);
        const historyData = historyResponse.ok ? await historyResponse.json() : null;
        const usedChips = getManagerChipUsage(historyData);
        const remainingChips = getRemainingChips(usedChips);

        const picksResponse = await fetch(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentEvent}/picks/`);
        if (!picksResponse.ok) throw new Error('Unable to fetch current squad for the manager.');
        const picksData = await picksResponse.json();
        const managerSquad = buildManagerSquad(picksData, playersById);

        const nextEvent = sourceData.events?.find(e => e.is_next === true)?.id || sourceData.events?.find(e => e.id === ((currentEvent || 0) + 1))?.id || null;
        const predictions = buildPredictions(players, liveCache.liveMode, { currentEvent, nextEvent });
        const managerRecommendations = buildManagerRecommendations(managerSquad, predictions);
        const chipAdvice = computeChipAdvice(remainingChips, managerSquad, predictions);

        return res.status(200).json({
          managerProfile: {
            id: profileData.id,
            name: profileData.player_name || `${profileData.player_first_name || ''} ${profileData.player_last_name || ''}`.trim(),
            player_first_name: profileData.player_first_name,
            player_last_name: profileData.player_last_name,
            team_name: profileData.name || profileData.team_name || '',
            total_points: profileData.summary?.total_points || null,
            overall_rank: profileData.summary?.overall_rank || null,
            usedChips,
            remainingChips
          },
          managerSquad,
          managerRecommendations: {
            ...managerRecommendations,
            chipAdvice,
            currentGameweek: currentEvent
          },
          liveMode: liveCache.liveMode,
          source: liveCache.liveMode ? 'FPL API' : 'Local fallback data'
        });
      } catch (error) {
        console.error('API /api/manager error:', error);
        return res.status(500).json({ message: error.message || 'Unable to load manager data.' });
      }
    }

    if (req.url === '/api/health' && req.method === 'GET') {
      return res.status(200).json({
        liveMode: liveCache.liveMode,
        source: liveCache.liveMode ? 'FPL API' : 'Local fallback data',
        lastUpdated: new Date(liveCache.fetchedAt).toISOString(),
        fixturesAvailable: Boolean(fixtureCache.data)
      });
    }

    return res.status(404).json({ message: 'Not found' });
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
}
