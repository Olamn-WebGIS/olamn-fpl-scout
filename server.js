import express from 'express';
import path from 'path';
import fs from 'fs/promises';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const STATIC_DATA_PATH = path.join(ROOT, 'static_data.json');
const LIVE_FPL_API_URL = process.env.LIVE_FPL_API_URL || process.env.FPL_API_URL || 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LIVE_FIXTURES_URL = process.env.LIVE_FIXTURES_URL || 'https://fantasy.premierleague.com/api/fixtures/';
const LIVE_CACHE_TTL = 30 * 1000; // 30 seconds cache to avoid repeated API hits
const WORLD_CUP_API_BASE = process.env.WC_API_URL || 'https://worldcupjson.net';
const STATIC_WC_FIXTURES_PATH = path.join(ROOT, 'wc-data-fixtures.json');
const STATIC_WC_MANUAL_PATH = path.join(ROOT, 'wc-data-manual.json');
const STATIC_WC_STANDINGS_PATH = path.join(ROOT, 'wc-data-standings.json');
const STATIC_WC_OVERVIEW_PATH = path.join(ROOT, 'wc-data-overview.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'secret-admin-token';

function getAdminToken(req) {
  return (
    String(req.headers['x-admin-token'] || req.query.token || req.body?.adminToken || '').trim()
  );
}

function requireAdminToken(req, res, next) {
  const token = getAdminToken(req);
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ message: 'Unauthorized admin access' });
  }
  next();
}

function requireAdminTokenForHtml(req, res, next) {
  const token = getAdminToken(req);
  if (token === ADMIN_TOKEN) {
    return next();
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-light">
  <div class="container py-5">
    <div class="card shadow-sm">
      <div class="card-body">
        <h1 class="h4 mb-3">Admin Access Required</h1>
        <p class="text-muted mb-4">Enter your secret admin token to continue.</p>
        <form id="adminLoginForm">
          <div class="mb-3">
            <input id="adminTokenInput" class="form-control" type="password" placeholder="Admin token" autocomplete="off">
          </div>
          <button class="btn btn-primary w-100">Continue</button>
        </form>
      </div>
    </div>
  </div>
  <script>
    const form = document.getElementById('adminLoginForm');
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      const token = document.getElementById('adminTokenInput').value.trim();
      if (!token) return;
      window.location.href = '/admin?token=' + encodeURIComponent(token);
    });
  </script>
</body>
</html>`);
}

let liveCache = { data: null, fetchedAt: 0, liveMode: false };
let fixtureCache = { data: null, fetchedAt: 0 };
let wcCache = { matches: null, fetchedAt: 0, liveMode: false };

const positionsMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

async function loadStaticData() {
  const raw = await fs.readFile(STATIC_DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function loadStaticWorldCupFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function loadManualWorldCupFile() {
  try {
    const raw = await fs.readFile(STATIC_WC_MANUAL_PATH, 'utf-8');
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    console.error('Unable to read manual World Cup file:', error);
    return [];
  }
}

async function saveManualWorldCupFile(data) {
  await fs.writeFile(STATIC_WC_MANUAL_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function mergeManualFixtures(staticFixtures, manualFixtures) {
  const manualMap = new Map();
  manualFixtures.forEach(block => {
    const key = block.groupName || block.roundName || '';
    if (key) manualMap.set(key, block);
  });

  const merged = staticFixtures.map(block => {
    const key = block.groupName || block.roundName || '';
    if (manualMap.has(key)) {
      const manualBlock = manualMap.get(key);
      return {
        ...block,
        ...manualBlock,
        matches: manualBlock.matches || block.matches
      };
    }
    return block;
  });

  manualFixtures.forEach(block => {
    const key = block.groupName || block.roundName || '';
    if (!merged.some(existing => (existing.groupName || existing.roundName || '') === key)) {
      merged.push(block);
    }
  });

  return merged;
}

function parseManualMatchScore(match) {
  const homeScoreRaw = match.homeGoals ?? match.home_score ?? match.homeScore;
  const awayScoreRaw = match.awayGoals ?? match.away_score ?? match.awayScore;
  if (homeScoreRaw === null || homeScoreRaw === undefined || homeScoreRaw === '') return null;
  if (awayScoreRaw === null || awayScoreRaw === undefined || awayScoreRaw === '') return null;

  const homeGoals = Number(homeScoreRaw);
  const awayGoals = Number(awayScoreRaw);
  if (Number.isNaN(homeGoals) || Number.isNaN(awayGoals)) {
    return null;
  }
  return { homeGoals, awayGoals };
}

function computeManualGroupStandings(manualFixtures) {
  const groups = {};

  manualFixtures.forEach(block => {
    const groupName = block.groupName || (typeof block.roundName === 'string' && block.roundName.startsWith('Group') ? block.roundName : null);
    if (!groupName || !Array.isArray(block.matches)) return;

    block.matches.forEach(match => {
      const score = parseManualMatchScore(match);
      if (!score) return;

      const homeName = match.home || 'TBD';
      const awayName = match.away || 'TBD';
      const homeFlag = match.homeFlag || match.home_flag || 'un';
      const awayFlag = match.awayFlag || match.away_flag || 'un';

      if (!groups[groupName]) {
        groups[groupName] = {};
      }

      const ensureTeam = (teamName, flagCode) => {
        if (!groups[groupName][teamName]) {
          groups[groupName][teamName] = {
            position: 0,
            teamName,
            flag: normalizeFlagCode(flagCode),
            played: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            gd: 0,
            points: 0,
            goalsFor: 0,
            goalsAgainst: 0
          };
        }
        return groups[groupName][teamName];
      };

      const homeTeam = ensureTeam(homeName, homeFlag);
      const awayTeam = ensureTeam(awayName, awayFlag);

      homeTeam.played += 1;
      awayTeam.played += 1;
      homeTeam.goalsFor += score.homeGoals;
      homeTeam.goalsAgainst += score.awayGoals;
      awayTeam.goalsFor += score.awayGoals;
      awayTeam.goalsAgainst += score.homeGoals;
      homeTeam.gd += score.homeGoals - score.awayGoals;
      awayTeam.gd += score.awayGoals - score.homeGoals;

      if (score.homeGoals > score.awayGoals) {
        homeTeam.wins += 1;
        awayTeam.losses += 1;
        homeTeam.points += 3;
      } else if (score.awayGoals > score.homeGoals) {
        awayTeam.wins += 1;
        homeTeam.losses += 1;
        awayTeam.points += 3;
      } else {
        homeTeam.draws += 1;
        awayTeam.draws += 1;
        homeTeam.points += 1;
        awayTeam.points += 1;
      }
    });
  });

  return Object.entries(groups).map(([groupName, teams]) => {
    const sortedTeams = Object.values(teams).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
      return a.teamName.localeCompare(b.teamName);
    }).map((team, index) => ({ ...team, position: index + 1 }));
    return { group: groupName, table: sortedTeams };
  });
}

function flattenManualFixtures(manualFixtures) {
  return manualFixtures.flatMap(block => {
    return (block.matches || []).map(match => ({
      ...match,
      group: block.groupName || (typeof block.roundName === 'string' && block.roundName.startsWith('Group') ? block.roundName : null)
    }));
  });
}

function normalizeFlagCode(value) {
  if (!value) return 'un';
  const code = String(value).trim();
  if (/^[A-Za-z]{2,3}$/.test(code)) {
    return code.toLowerCase();
  }

  const map = {
    'United States': 'us',
    'USA': 'us',
    'South Korea': 'kr',
    'North Korea': 'kp',
    'Czechia': 'cz',
    'Czech Republic': 'cz',
    'United Kingdom': 'gb',
    'Saudi Arabia': 'sa',
    'Türkiye': 'tr',
    'Cabo Verde': 'cv',
    'Ivory Coast': 'ci',
    'DR Congo': 'cd',
    'United States of America': 'us',
    'South Africa': 'za',
    'New Zealand': 'nz',
    'Bosnia and Herzegovina': 'ba',
    'England': 'gb-eng',
    'Scotland': 'gb-sct',
    'Wales': 'gb-wls',
    'Northern Ireland': 'gb-nir'
  };
  if (map[code]) return map[code];
  return code.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || 'un';
}

function getWorldCupTeamName(match, side) {
  return match[`${side}_team`]?.country || match[`${side}_team_country`] || match[`${side}_team_country_name`] || match[`${side}`] || 'TBD';
}

function getWorldCupTeamFlag(match, side) {
  const team = match[`${side}_team`];
  if (team) {
    return normalizeFlagCode(team.iso2 || team.code || team.country_code || team.country || team.name);
  }
  return normalizeFlagCode(match[`${side}_team_country_code`] || match[`${side}_team_country`] || match[`${side}`]);
}

function buildTeamFlagMap(fixtures) {
  const flags = {};
  fixtures.forEach(block => {
    (block.matches || []).forEach(match => {
      if (match.home) {
        flags[match.home] = normalizeFlagCode(match.homeFlag || match.home_flag || match.home);
      }
      if (match.away) {
        flags[match.away] = normalizeFlagCode(match.awayFlag || match.away_flag || match.away);
      }
    });
  });
  return flags;
}

function getMatchWinner(match) {
  const score = parseManualMatchScore(match);
  if (!score) return null;
  if (score.homeGoals > score.awayGoals) return match.home;
  if (score.awayGoals > score.homeGoals) return match.away;
  return null;
}

function getMatchLoser(match) {
  const score = parseManualMatchScore(match);
  if (!score) return null;
  if (score.homeGoals > score.awayGoals) return match.away;
  if (score.awayGoals > score.homeGoals) return match.home;
  return null;
}

function getRoundMatch(fixtures, roundName, matchIndex) {
  const block = fixtures.find(item => item.roundName === roundName);
  if (!block || !Array.isArray(block.matches)) return null;
  return block.matches[matchIndex - 1] || null;
}

function sortBestThirds(standings) {
  return standings
    .map(group => group.table[2])
    .filter(Boolean)
    .sort((a, b) => {
      if ((b.points || 0) !== (a.points || 0)) return (b.points || 0) - (a.points || 0);
      if ((b.gd || 0) !== (a.gd || 0)) return (b.gd || 0) - (a.gd || 0);
      if ((b.goalsFor || 0) !== (a.goalsFor || 0)) return (b.goalsFor || 0) - (a.goalsFor || 0);
      return String(a.teamName || a.team || '').localeCompare(String(b.teamName || b.team || ''));
    });
}

function resolveKnockoutPlaceholderName(value, standings, fixtures) {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim();
  const groupWinner = cleaned.match(/^Winner Group ([A-L])$/i);
  const groupRunner = cleaned.match(/^Runner-?up Group ([A-L])$/i);
  const bestThird = cleaned.match(/^Best 3rd #?(\d+)$/i);
  const winnerR32 = cleaned.match(/^W-R32 Match (\d+)$/i);
  const winnerR16 = cleaned.match(/^W-R16 Match (\d+)$/i);
  const winnerQF = cleaned.match(/^W-QF Match (\d+)$/i);
  const winnerSF = cleaned.match(/^W-SF Match (\d+)$/i);
  const loserSF = cleaned.match(/^L-SF Match (\d+)$/i);

  if (groupWinner && standings) {
    const groupName = `Group ${groupWinner[1].toUpperCase()}`;
    const group = standings.find(item => item.group === groupName);
    return group?.table?.[0]?.teamName || value;
  }

  if (groupRunner && standings) {
    const groupName = `Group ${groupRunner[1].toUpperCase()}`;
    const group = standings.find(item => item.group === groupName);
    return group?.table?.[1]?.teamName || value;
  }

  if (bestThird && standings) {
    const index = Number(bestThird[1]) - 1;
    const thirdTeams = sortBestThirds(standings);
    return thirdTeams[index]?.teamName || value;
  }

  if (winnerR32) {
    const match = getRoundMatch(fixtures, 'Round of 32', Number(winnerR32[1]));
    return getMatchWinner(match) || value;
  }
  if (winnerR16) {
    const match = getRoundMatch(fixtures, 'Round of 16', Number(winnerR16[1]));
    return getMatchWinner(match) || value;
  }
  if (winnerQF) {
    const match = getRoundMatch(fixtures, 'Quarter-finals', Number(winnerQF[1]));
    return getMatchWinner(match) || value;
  }
  if (winnerSF) {
    const match = getRoundMatch(fixtures, 'Semi-finals', Number(winnerSF[1]));
    return getMatchWinner(match) || value;
  }
  if (loserSF) {
    const match = getRoundMatch(fixtures, 'Semi-finals', Number(loserSF[1]));
    return getMatchLoser(match) || value;
  }

  return value;
}

function resolveKnockoutTeamNames(fixtures, standings, manualFixtures) {
  const flagMap = buildTeamFlagMap([...fixtures, ...(manualFixtures || [])]);

  return fixtures.map(block => ({
    ...block,
    matches: (block.matches || []).map(match => {
      const resolvedHome = resolveKnockoutPlaceholderName(match.home, standings, fixtures);
      const resolvedAway = resolveKnockoutPlaceholderName(match.away, standings, fixtures);
      return {
        ...match,
        home: resolvedHome,
        away: resolvedAway,
        homeFlag: flagMap[resolvedHome] || normalizeFlagCode(match.homeFlag || match.home_flag || match.home),
        awayFlag: flagMap[resolvedAway] || normalizeFlagCode(match.awayFlag || match.away_flag || match.away)
      };
    })
  }));
}

function parseWorldCupMatchDate(match) {
  return match.datetime || match.date || match.kickoff_time || match.scheduled || '';
}

function buildWorldCupMatchBlock(matches) {
  const blocks = [];
  const grouped = new Map();

  matches.forEach(match => {
    const groupName = match.group || match.stage_name || match.round_name || match.round || null;
    const normalizedGroup = typeof groupName === 'string' && groupName.startsWith('Group') ? groupName : null;
    const heading = normalizedGroup || match.stage_name || match.round_name || match.stage || 'Knockout';
    const blockKey = normalizedGroup ? `group:${normalizedGroup}` : `round:${heading}`;

    if (!grouped.has(blockKey)) {
      grouped.set(blockKey, {
        groupName: normalizedGroup || null,
        roundName: normalizedGroup ? null : heading,
        matches: []
      });
    }

    const block = grouped.get(blockKey);
    block.matches.push({
      date: parseWorldCupMatchDate(match),
      home: getWorldCupTeamName(match, 'home'),
      homeFlag: getWorldCupTeamFlag(match, 'home'),
      away: getWorldCupTeamName(match, 'away'),
      awayFlag: getWorldCupTeamFlag(match, 'away')
    });
  });

  grouped.forEach(block => blocks.push(block));
  return blocks;
}

function computeWorldCupGroupStandings(matches) {
  const groups = {};

  matches.forEach(match => {
    const groupName = match.group || (typeof match.stage_name === 'string' && match.stage_name.startsWith('Group') ? match.stage_name : null);
    if (!groupName) return;

    const homeName = getWorldCupTeamName(match, 'home');
    const awayName = getWorldCupTeamName(match, 'away');
    const homeGoals = Number.isFinite(match.home_team?.goals) ? match.home_team.goals : Number(match.home_team_goals);
    const awayGoals = Number.isFinite(match.away_team?.goals) ? match.away_team.goals : Number(match.away_team_goals);
    if (Number.isNaN(homeGoals) || Number.isNaN(awayGoals)) return;

    if (!groups[groupName]) {
      groups[groupName] = {};
    }

    const ensureTeam = (teamName, flagCode) => {
      if (!groups[groupName][teamName]) {
        groups[groupName][teamName] = {
          position: 0,
          teamName,
          flag: normalizeFlagCode(flagCode),
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          gd: 0,
          points: 0,
          goalsFor: 0,
          goalsAgainst: 0
        };
      }
      return groups[groupName][teamName];
    };

    const homeTeam = ensureTeam(homeName, getWorldCupTeamFlag(match, 'home'));
    const awayTeam = ensureTeam(awayName, getWorldCupTeamFlag(match, 'away'));

    homeTeam.played += 1;
    awayTeam.played += 1;
    homeTeam.goalsFor += homeGoals;
    homeTeam.goalsAgainst += awayGoals;
    awayTeam.goalsFor += awayGoals;
    awayTeam.goalsAgainst += homeGoals;
    homeTeam.gd += homeGoals - awayGoals;
    awayTeam.gd += awayGoals - homeGoals;

    if (homeGoals > awayGoals) {
      homeTeam.wins += 1;
      awayTeam.losses += 1;
      homeTeam.points += 3;
    } else if (awayGoals > homeGoals) {
      awayTeam.wins += 1;
      homeTeam.losses += 1;
      awayTeam.points += 3;
    } else {
      homeTeam.draws += 1;
      awayTeam.draws += 1;
      homeTeam.points += 1;
      awayTeam.points += 1;
    }
  });

  return Object.entries(groups).map(([groupName, teams]) => {
    const sortedTeams = Object.values(teams).sort((a,b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
      return a.teamName.localeCompare(b.teamName);
    }).map((team, index) => ({ ...team, position: index + 1 }));
    return { group: groupName, table: sortedTeams };
  });
}

function formatWorldCupDate(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date)) return '';
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short' }).format(date).toUpperCase();
}

function formatWorldCupTime(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date)) return '';
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function buildWorldCupOverview(matches, fallbackOverview) {
  const now = new Date();
  const upcoming = matches
    .filter(match => {
      const date = new Date(parseWorldCupMatchDate(match));
      return date > now;
    })
    .sort((a, b) => new Date(parseWorldCupMatchDate(a)) - new Date(parseWorldCupMatchDate(b)));

  if (upcoming.length > 0) {
    const next = upcoming[0];
    return {
      featuredFixture: {
        date: formatWorldCupDate(parseWorldCupMatchDate(next)),
        time: formatWorldCupTime(parseWorldCupMatchDate(next)),
        homeTeam: getWorldCupTeamName(next, 'home'),
        homeFlag: getWorldCupTeamFlag(next, 'home'),
        awayTeam: getWorldCupTeamName(next, 'away'),
        awayFlag: getWorldCupTeamFlag(next, 'away')
      },
      qualificationGroup: fallbackOverview?.qualificationGroup || {
        title: 'Qualification',
        subtitle: 'Current qualifiers from the World Cup',
        table: []
      }
    };
  }

  return fallbackOverview || {
    featuredFixture: {
      date: '',
      time: '',
      homeTeam: 'TBD',
      homeFlag: 'un',
      awayTeam: 'TBD',
      awayFlag: 'un'
    },
    qualificationGroup: {
      title: 'Qualification',
      subtitle: 'Current qualifiers from the World Cup',
      table: []
    }
  };
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

async function loadLiveFixtures() {
  const now = Date.now();
  if (fixtureCache.data && now - fixtureCache.fetchedAt < LIVE_CACHE_TTL) {
    return fixtureCache.data;
  }

  try {
    const response = await fetch(LIVE_FIXTURES_URL);
    if (!response.ok) {
      throw new Error(`Fixtures request failed: ${response.status}`);
    }
    const json = await response.json();
    fixtureCache = { data: json, fetchedAt: now };
    return json;
  } catch (error) {
    console.warn('Live fixtures fetch failed, no fixture weighting will be applied.', error.message);
    return null;
  }
}

function isWorldCup2026Matches(matches) {
  if (!Array.isArray(matches) || !matches.length) {
    return false;
  }

  return matches.some(match => {
    const date = new Date(parseWorldCupMatchDate(match));
    return !Number.isNaN(date) && date.getFullYear() === 2026;
  });
}

async function loadWorldCupMatches() {
  // Manual-only mode: do not fetch live World Cup tournament data from external APIs.
  return null;
}

function buildTeamMap(data) {
  return data.teams.reduce((acc, team) => {
    acc[team.id] = team.name;
    return acc;
  }, {});
}

function getNextFixtureForTeam(fixtures, teamId) {
  if (!Array.isArray(fixtures)) return null;

  const upcoming = fixtures
    .filter(fixture => fixture.kickoff_time && new Date(fixture.kickoff_time) > new Date())
    .filter(fixture => fixture.team_h === teamId || fixture.team_a === teamId)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  if (!upcoming.length) return null;
  const next = upcoming[0];
  const isHome = next.team_h === teamId;
  return {
    opponent: isHome ? next.team_a : next.team_h,
    difficulty: isHome ? next.team_h_difficulty : next.team_a_difficulty,
    isHome,
    kickoff: next.kickoff_time
  };
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

app.get('/api/wc/fixtures', async (req, res) => {
  try {
    const manualFixtures = await loadManualWorldCupFile();
    if (manualFixtures.length) {
      const staticFixtures = await loadStaticWorldCupFile(STATIC_WC_FIXTURES_PATH);
      const mergedFixtures = mergeManualFixtures(staticFixtures, manualFixtures);
      const standings = computeManualGroupStandings(manualFixtures);
      return res.json(resolveKnockoutTeamNames(mergedFixtures, standings, manualFixtures));
    }

    const fallback = await loadStaticWorldCupFile(STATIC_WC_FIXTURES_PATH);
    res.json(fallback);
  } catch (error) {
    console.error('API /api/wc/fixtures error:', error);
    res.status(500).json({ message: 'Unable to load world cup fixtures' });
  }
});

app.get('/api/wc/manual-fixtures', requireAdminToken, async (req, res) => {
  try {
    const manualFixtures = await loadManualWorldCupFile();
    const staticFixtures = await loadStaticWorldCupFile(STATIC_WC_FIXTURES_PATH);
    if (manualFixtures.length) {
      return res.json(mergeManualFixtures(staticFixtures, manualFixtures));
    }
    res.json(staticFixtures);
  } catch (error) {
    console.error('API /api/wc/manual-fixtures error:', error);
    res.status(500).json({ message: 'Unable to load manual fixture data' });
  }
});

app.post('/api/wc/manual-fixtures', requireAdminToken, async (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ message: 'Manual fixture data must be an array of groups.' });
    }
    await saveManualWorldCupFile(data);
    res.json({ success: true });
  } catch (error) {
    console.error('API POST /api/wc/manual-fixtures error:', error);
    res.status(500).json({ message: 'Unable to save manual fixture data' });
  }
});

app.get('/api/wc/standings', async (req, res) => {
  try {
    const fallback = await loadStaticWorldCupFile(STATIC_WC_STANDINGS_PATH);
    const manualFixtures = await loadManualWorldCupFile();
    if (manualFixtures.length) {
      const manualStandings = computeManualGroupStandings(manualFixtures);
      if (manualStandings.length) {
        const manualMap = new Map(manualStandings.map(group => [group.group, group]));
        const mergedStandings = fallback.map(group => manualMap.get(group.group) || group);
        return res.json(mergedStandings);
      }
    }

    res.json(fallback);
  } catch (error) {
    console.error('API /api/wc/standings error:', error);
    res.status(500).json({ message: 'Unable to load world cup standings' });
  }
});

app.get('/api/wc/overview', async (req, res) => {
  try {
    const fallbackOverview = await loadStaticWorldCupFile(STATIC_WC_OVERVIEW_PATH);
    const manualFixtures = await loadManualWorldCupFile();
    if (manualFixtures.length) {
      const staticFixtures = await loadStaticWorldCupFile(STATIC_WC_FIXTURES_PATH);
      const mergedFixtures = mergeManualFixtures(staticFixtures, manualFixtures);
      const standings = computeManualGroupStandings(manualFixtures);
      const resolvedFixtures = resolveKnockoutTeamNames(mergedFixtures, standings, manualFixtures);
      const manualMatches = flattenManualFixtures(resolvedFixtures);
      return res.json(buildWorldCupOverview(manualMatches, fallbackOverview));
    }

    res.json(fallbackOverview);
  } catch (error) {
    console.error('API /api/wc/overview error:', error);
    res.status(500).json({ message: 'Unable to load world cup overview' });
  }
});

app.get('/admin', requireAdminTokenForHtml, async (req, res) => {
  res.sendFile(path.join(ROOT, 'admin.html'));
});

app.use((req, res, next) => {
  if (req.path === '/admin.html') {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(ROOT));

app.listen(PORT, () => {
  console.log(`FPL Scout server listening on http://localhost:${PORT}`);
  console.log(`Live FPL source ${LIVE_FPL_API_URL ? 'enabled' : 'disabled'}`);
});
