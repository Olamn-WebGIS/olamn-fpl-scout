import express from 'express';
import path from 'path';
import fs from 'fs/promises';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const STATIC_DATA_PATH = path.join(ROOT, 'static_data.json');
const LIVE_FPL_API_URL = process.env.LIVE_FPL_API_URL || process.env.FPL_API_URL || 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LIVE_FIXTURES_URL = process.env.LIVE_FIXTURES_URL || 'https://fantasy.premierleague.com/api/fixtures/';
const LIVE_CACHE_TTL = 30 * 1000; // 30 seconds cache to avoid repeated API hits

let liveCache = { data: null, fetchedAt: 0, liveMode: false };
let fixtureCache = { data: null, fetchedAt: 0 };
let wcCache = { matches: null, fetchedAt: 0, liveMode: false };

const positionsMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

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
    if (!response.ok) {
      throw new Error(`Live data request failed: ${response.status}`);
    }
    const json = await response.json();
    liveCache = { data: json, fetchedAt: now, liveMode: true };
    return json;
  } catch (error) {
    console.warn('Live FPL API fetch failed, using local JSON fallback.', error.message);
    liveCache.liveMode = false;
    return null;
  }
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : parseFloat(value) || 0;
}

function parsePercent(value) {
  if (typeof value === 'string') {
    return parseFloat(value.replace('%', '')) || 0;
  }
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

  if (player.status && player.status.toLowerCase() !== 'a') {
    score *= 0.55;
  }

  if (fixtureInfo && typeof fixtureInfo.difficulty === 'number') {
    const difficultyBoost = (6 - fixtureInfo.difficulty) * 0.22;
    score += difficultyBoost;
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

  return {
    id: player.id,
    name: player.web_name || `${player.first_name || ''} ${player.second_name || ''}`.trim(),
    first_name: player.first_name,
    second_name: player.second_name,
    pos: positionsMap[player.element_type] || 'N/A',
    team: teamMap[player.team] || 'Unknown',
    team_id: player.team,
    pts: safeNumber(player.total_points),
    total_points: safeNumber(player.total_points),
    price,
    now_cost: safeNumber(player.now_cost),
    form: safeNumber(player.form),
    predictedPoints,
    captainScore,
    nextFixture,
    next_opponent_id: fixtureInfo ? fixtureInfo.opponent : null,
    next_fixture_difficulty: fixtureInfo ? fixtureInfo.difficulty : null,
    next_fixture_is_home: fixtureInfo ? fixtureInfo.isHome : null,
    next_fixture_kickoff: fixtureInfo ? fixtureInfo.kickoff : null,
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

function buildPredictions(players, liveMode = false) {
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
    news: p.news
  }));

  const captainPicks = sortedByCaptain.slice(0, 5).map(p => ({
    id: p.id,
    name: p.name,
    team: p.team,
    pos: p.pos,
    captainScore: p.captainScore,
    predictedPoints: p.predictedPoints,
    nextFixture: p.nextFixture
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
      liveMode
    }
  };
}

app.get('/api/players', async (req, res) => {
  try {
    const sourceData = await loadLiveData() || await loadStaticData();
    const fixtures = await loadLiveFixtures();
    const teamMap = buildTeamMap(sourceData);
    const players = sourceData.elements.map(player => {
      const fixtureInfo = fixtures ? getNextFixtureForTeam(fixtures, player.team) : null;
      return normalizePlayer(player, teamMap, fixtureInfo);
    });

    const search = (req.query.search || '').toString().toLowerCase();
    const position = (req.query.position || '').toString().toUpperCase();

    let filtered = players;
    if (search) {
      filtered = filtered.filter(player => player.name.toLowerCase().includes(search) || player.team.toLowerCase().includes(search));
    }
    if (position && position !== 'ALL') {
      filtered = filtered.filter(player => player.pos === position);
    }

    res.json(filtered.sort((a, b) => b.predictedPoints - a.predictedPoints));
  } catch (error) {
    console.error('API /api/players error:', error);
    res.status(500).json({ message: 'Unable to load player data' });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    const sourceData = await loadLiveData() || await loadStaticData();
    const fixtures = await loadLiveFixtures();
    const teamMap = buildTeamMap(sourceData);
    const players = sourceData.elements.map(player => {
      const fixtureInfo = fixtures ? getNextFixtureForTeam(fixtures, player.team) : null;
      return normalizePlayer(player, teamMap, fixtureInfo);
    });
    res.json(buildPredictions(players, liveCache.liveMode));
  } catch (error) {
    console.error('API /api/predictions error:', error);
    res.status(500).json({ message: 'Unable to compute predictions' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await loadLiveData();
    await loadLiveFixtures();
    const health = {
      liveMode: liveCache.liveMode,
      source: liveCache.liveMode ? 'FPL API' : 'Local fallback data',
      lastUpdated: new Date(liveCache.fetchedAt).toISOString(),
      fixturesAvailable: Boolean(fixtureCache.data)
    };
    res.json(health);
  } catch (error) {
    console.error('API /api/health error:', error);
    res.status(500).json({ message: 'Unable to determine health status' });
  }
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const fixtures = await loadLiveFixtures();
    if (!fixtures) {
      return res.status(502).json({ message: 'Unable to load fixtures' });
    }
    res.json(fixtures);
  } catch (error) {
    console.error('API /api/fixtures error:', error);
    res.status(500).json({ message: 'Unable to load fixtures' });
  }
});

app.get('/api/teams', async (req, res) => {
  try {
    const sourceData = await loadLiveData() || await loadStaticData();
    const teams = sourceData.teams.map(team => ({ id: team.id, name: team.name, short_name: team.short_name }));
    res.json(teams);
  } catch (error) {
    console.error('API /api/teams error:', error);
    res.status(500).json({ message: 'Unable to load teams' });
  }
});