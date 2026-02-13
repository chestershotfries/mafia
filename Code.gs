/* Google Apps Script backend for Mafia TrueSkill tracker.
 *
 * Deploy as Web App: Execute as Me, Anyone can access.
 * Reads/writes the shared Google Sheet directly.
 */

const SHEET_ID = '1vTc6XAa4beDM4n1syQ22Hs10JGVT9PuHNSoTmY051CQ';
const TRUESKILL_MU = 25;
const TRUESKILL_SIGMA = 25 / 3;
const TRUESKILL_BETA = 40.7;
const TRUESKILL_TAU = 0.0;

const POSITION_ROLES = {
  1: 'Mafia', 2: 'Mafia', 3: 'Mafia',
  4: 'Cop', 5: 'Medic', 6: 'Vigilante',
};

const ROLE_HISTORY_HEADERS = ['GameID', 'Player', 'Position', 'Role'];

// --- API Router ---

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var action = body.action;
  var result;

  try {
    switch (action) {
      case 'getPlayers':
        result = getPlayers();
        break;
      case 'getLastGame':
        result = getLastGame();
        break;
      case 'recordGame':
        result = recordGame(body);
        break;
      default:
        result = {error: 'Unknown action: ' + action};
    }
  } catch (err) {
    result = {error: err.message};
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- Normal Distribution ---

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normalCdf(x) {
  // Abramowitz & Stegun approximation 7.1.26 (max error 1.5e-7)
  var sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  var t = 1.0 / (1.0 + 0.3275911 * x);
  var a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  var y = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t;
  var erf = 1.0 - y * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * erf);
}

// Truncated Gaussian functions for win case (no draw)
function vFunc(t) {
  var denom = normalCdf(t);
  if (denom < 1e-15) return -t; // avoid division by zero for extreme values
  return normalPdf(t) / denom;
}

function wFunc(t) {
  var v = vFunc(t);
  return v * (v + t);
}

// --- TrueSkill ---

function computeTrueSkill(mafiaPlayers, townPlayers, mafiaWon) {
  // Collect all players with team labels
  var winners = mafiaWon ? mafiaPlayers : townPlayers;
  var losers = mafiaWon ? townPlayers : mafiaPlayers;

  // Sum team means and total sigma squared
  var muWin = 0, muLose = 0, sumSigmaSq = 0;
  var nTotal = winners.length + losers.length;

  for (var i = 0; i < winners.length; i++) {
    muWin += winners[i].mu;
    sumSigmaSq += winners[i].sigma * winners[i].sigma;
  }
  for (var i = 0; i < losers.length; i++) {
    muLose += losers[i].mu;
    sumSigmaSq += losers[i].sigma * losers[i].sigma;
  }

  var c = Math.sqrt(sumSigmaSq + nTotal * TRUESKILL_BETA * TRUESKILL_BETA);
  var t = (muWin - muLose) / c;
  var v = vFunc(t);
  var w = wFunc(t);

  var result = {};

  // Update winners: mu increases
  for (var i = 0; i < winners.length; i++) {
    var p = winners[i];
    var sigmaSq = p.sigma * p.sigma;
    var newMu = p.mu + (sigmaSq / c) * v;
    var newSigmaSq = sigmaSq * (1 - (sigmaSq / (c * c)) * w);
    var newSigma = Math.sqrt(Math.max(newSigmaSq, 1e-10));
    result[p.name] = {mu: newMu, sigma: newSigma};
  }

  // Update losers: mu decreases
  for (var i = 0; i < losers.length; i++) {
    var p = losers[i];
    var sigmaSq = p.sigma * p.sigma;
    var newMu = p.mu - (sigmaSq / c) * v;
    var newSigmaSq = sigmaSq * (1 - (sigmaSq / (c * c)) * w);
    var newSigma = Math.sqrt(Math.max(newSigmaSq, 1e-10));
    result[p.name] = {mu: newMu, sigma: newSigma};
  }

  return result;
}

// --- Sheet Operations ---

function getPlayers() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ws = ss.getSheetByName('MatchRatings');
  var data = ws.getDataRange().getValues();
  var players = [];
  for (var i = 1; i < data.length; i++) {
    var name = data[i][0];
    var mu = data[i][1];
    var sigma = data[i][2];
    if (!name) continue;
    var rating = Math.round((mu - 1.5 * sigma) * 68);
    players.push({name: name, mu: mu, sigma: sigma, rating: rating});
  }
  return {players: players};
}

function getLastGame() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ws = ss.getSheetByName('MatchHistory');
  var data = ws.getDataRange().getValues();

  if (data.length < 2 || !data[1][0]) {
    return {game: null};
  }

  var gameId = data[1][0];
  var players = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] !== gameId) break;
    players.push({
      game_id: Number(gameId),
      player: data[i][1],
      alignment: data[i][2],
      result: data[i][3],
      rate_change: data[i][4],
      old_mu: data[i][5],
      new_mu: data[i][6],
      new_sigma: data[i][7],
      old_rating: data[i][8],
      new_rating: data[i][9],
      old_sigma: data[i][10],
    });
  }
  return {game: {game_id: Number(gameId), players: players}};
}

function recordGame(body) {
  var assignments = body.assignments;
  var winner = body.winner;
  var night0Kills = body.night0_kills || [];
  var mafiaWon = winner === 'Mafia';

  // Filter out ghosts and Night 0 kills for rating
  var rated = assignments.filter(function(a) {
    return !a.is_ghost && night0Kills.indexOf(a.name) === -1;
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var wsRatings = ss.getSheetByName('MatchRatings');
    var wsHistory = ss.getSheetByName('MatchHistory');

    // Build current ratings lookup
    var ratingsData = wsRatings.getDataRange().getValues();
    var currentRatings = {};
    for (var i = 1; i < ratingsData.length; i++) {
      var name = ratingsData[i][0];
      if (!name) continue;
      currentRatings[name] = {
        mu: ratingsData[i][1],
        sigma: ratingsData[i][2],
        row: i + 1, // 1-indexed sheet row
      };
    }

    // Build team player lists
    var mafiaPlayers = [];
    var townPlayers = [];
    for (var i = 0; i < rated.length; i++) {
      var a = rated[i];
      var cr = currentRatings[a.name];
      var player = {
        name: a.name,
        mu: cr ? cr.mu : TRUESKILL_MU,
        sigma: cr ? cr.sigma : TRUESKILL_SIGMA,
      };
      if (a.role === 'Mafia') {
        mafiaPlayers.push(player);
      } else {
        townPlayers.push(player);
      }
    }

    // Run TrueSkill
    var newRatings = computeTrueSkill(mafiaPlayers, townPlayers, mafiaWon);

    // Determine next GameID
    var historyData = wsHistory.getDataRange().getValues();
    var currentGameId = historyData.length > 1 ? historyData[1][0] : null;
    var nextGameId = currentGameId ? Number(currentGameId) + 1 : 46;

    // Insert rows at row 2 of MatchHistory
    wsHistory.insertRowsBefore(2, rated.length);

    var resultPlayers = [];
    for (var i = 0; i < rated.length; i++) {
      var a = rated[i];
      var rowIdx = 2 + i;
      var alignment = a.role;
      var resultStr = (alignment === 'Mafia') === mafiaWon ? 'Win' : 'Loss';

      var cr = currentRatings[a.name];
      var oldMu = cr ? cr.mu : TRUESKILL_MU;
      var oldSigma = cr ? cr.sigma : TRUESKILL_SIGMA;

      var nr = newRatings[a.name];
      var newMu = nr.mu;
      var newSigma = nr.sigma;

      var oldRating = Math.round((oldMu - 1.5 * oldSigma) * 68);
      var newRating = Math.round((newMu - 1.5 * newSigma) * 68);
      var rateChange = newRating - oldRating;

      // Write row: GameID, Player, Alignment, Result, RateChange,
      //            old_mu, new_mu, new_sigma, old_rating, new_rating, old_sigma
      wsHistory.getRange(rowIdx, 1, 1, 11).setValues([[
        nextGameId, a.name, alignment, resultStr, rateChange,
        oldMu, newMu, newSigma, oldRating, newRating, oldSigma,
      ]]);

      resultPlayers.push({
        name: a.name,
        alignment: alignment,
        result: resultStr,
        old_rating: oldRating,
        new_rating: newRating,
        rate_change: rateChange,
        old_mu: oldMu,
        new_mu: newMu,
        old_sigma: oldSigma,
        new_sigma: newSigma,
      });
    }

    // Update MatchRatings
    for (var i = 0; i < rated.length; i++) {
      var a = rated[i];
      var nr = newRatings[a.name];
      var cr = currentRatings[a.name];
      if (cr) {
        wsRatings.getRange(cr.row, 2, 1, 2).setValues([[nr.mu, nr.sigma]]);
      } else {
        var newRow = wsRatings.getLastRow() + 1;
        wsRatings.getRange(newRow, 1, 1, 3).setValues([[a.name, nr.mu, nr.sigma]]);
        currentRatings[a.name] = {mu: nr.mu, sigma: nr.sigma, row: newRow};
      }
    }

    // Write RoleHistory (positions 1-6)
    var wsRoles;
    try {
      wsRoles = ss.getSheetByName('RoleHistory');
    } catch (_) {
      wsRoles = null;
    }
    if (!wsRoles) {
      wsRoles = ss.insertSheet('RoleHistory');
      wsRoles.getRange(1, 1, 1, 4).setValues([ROLE_HISTORY_HEADERS]);
    }

    var roleEntries = [];
    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i];
      var role = POSITION_ROLES[a.position];
      if (!role) continue;
      var rRow = wsRoles.getLastRow() + 1;
      wsRoles.getRange(rRow, 1, 1, 4).setValues([[nextGameId, a.name, a.position, role]]);
      roleEntries.push({
        name: a.name,
        position: a.position,
        role: role,
        is_ghost: a.is_ghost,
      });
    }

    SpreadsheetApp.flush();

    return {
      game_id: nextGameId,
      players: resultPlayers,
      roles: roleEntries,
      excluded: {
        ghosts: assignments.filter(function(a) { return a.is_ghost; }).map(function(a) { return a.name; }),
        night0_kills: night0Kills,
      },
    };
  } finally {
    lock.releaseLock();
  }
}
