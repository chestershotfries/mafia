/* Mafia Randomizer frontend — GitHub Pages + Google Apps Script */

// Replace with your Apps Script deployment URL
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx26D5vPJ2_3wy5bkvi_TGnCrzK6JFM8gpnPrn1fxj9l3WxcjsgI7EfVBaxT_ajw8dY/exec';

const GHOST_NAME = 'Ghost';

let currentAssignments = null;
let knownPlayers = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Toast ---

function showToast(msg, isSuccess) {
	const toast = $('#toast');
	toast.textContent = msg;
	toast.classList.toggle('success', !!isSuccess);
	toast.classList.remove('hidden');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

// --- Panel switching ---

function showPanel(id) {
	$$('.panel').forEach((p) => p.classList.add('hidden'));
	$(`#${id}`).classList.remove('hidden');
}

// --- API helper (Apps Script) ---

async function api(action, data = {}) {
	const resp = await fetch(SCRIPT_URL, {
		method: 'POST',
		body: JSON.stringify({ action, ...data }),
		// No Content-Type header — avoids CORS preflight with Apps Script
	});
	const result = await resp.json();
	if (result.error) {
		throw new Error(result.error);
	}
	return result;
}

// --- Name counter ---

function countNames() {
	const raw = $('#names-input').value;
	let names;
	if (raw.includes(',')) {
		names = raw.split(',').map((n) => n.trim()).filter(Boolean);
	} else {
		names = raw.split('\n').map((n) => n.trim()).filter(Boolean);
	}
	const count = names.length;
	const ghosts = count >= 13 && count <= 15 ? 15 - count : 0;
	const ghostText = count >= 13 && count <= 15
		? ` (${ghosts} ghost${ghosts !== 1 ? 's' : ''} will be added)`
		: '';
	$('#name-counter').textContent = `${count}/15 names${ghostText}`;
	return count;
}

// --- Client-side randomization (ported from engine.py) ---

function validateNames(rawInput) {
	let names;
	if (rawInput.includes(',')) {
		names = rawInput.split(',').map((n) => n.trim()).filter(Boolean);
	} else {
		names = rawInput.split('\n').map((n) => n.trim()).filter(Boolean);
	}

	const seen = new Set();
	const dupes = [];
	for (const n of names) {
		const lower = n.toLowerCase();
		if (seen.has(lower)) dupes.push(n);
		seen.add(lower);
	}
	if (dupes.length) {
		throw new Error(`Duplicate names: ${dupes.join(', ')}`);
	}
	if (names.length < 13 || names.length > 15) {
		throw new Error(`Need 13-15 players, got ${names.length}`);
	}
	return names;
}

function shuffleArray(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function randomize(names) {
	const numGhosts = 15 - names.length;
	const real = shuffleArray([...names]);

	// Zone 1 (positions 1-3): Mafia — always real players
	const mafia = real.slice(0, 3);
	let remaining = real.slice(3);

	// Zone 2 (positions 4-6): Town — 0 or 1 ghost, rest real
	const ghostsInZone2 = Math.min(numGhosts, Math.round(Math.random()));
	const ghostsInZone3 = numGhosts - ghostsInZone2;

	const zone2RealCount = 3 - ghostsInZone2;
	const zone2Real = remaining.slice(0, zone2RealCount);
	remaining = remaining.slice(zone2RealCount);
	const zone2All = shuffleArray([...zone2Real, ...Array(ghostsInZone2).fill(GHOST_NAME)]);

	// Zone 3 (positions 7-15): Town — remaining real + remaining ghosts
	const zone3 = shuffleArray([...remaining, ...Array(ghostsInZone3).fill(GHOST_NAME)]);

	shuffleArray(mafia);

	const assignments = [];
	mafia.forEach((name, i) => {
		assignments.push({ position: i + 1, name, role: 'Mafia', is_ghost: false });
	});
	zone2All.forEach((name, i) => {
		assignments.push({ position: i + 4, name, role: 'Town', is_ghost: name === GHOST_NAME });
	});
	zone3.forEach((name, i) => {
		assignments.push({ position: i + 7, name, role: 'Town', is_ghost: name === GHOST_NAME });
	});

	return assignments;
}

// --- Render assignments ---

function renderAssignments(assignments, listEl) {
	listEl.innerHTML = '';
	for (const a of assignments) {
		const li = document.createElement('li');
		const posSpan = document.createElement('span');
		posSpan.className = 'pos-num';
		posSpan.textContent = a.position + '.';

		const nameSpan = document.createElement('span');
		if (a.role === 'Mafia') {
			nameSpan.className = 'mafia';
			nameSpan.textContent = `${a.name} (Mafia)`;
		} else if (a.is_ghost) {
			nameSpan.className = 'ghost';
			nameSpan.textContent = `${a.name} (Ghost)`;
		} else {
			nameSpan.className = 'town';
			nameSpan.textContent = a.name;
		}

		li.appendChild(posSpan);
		li.appendChild(nameSpan);
		listEl.appendChild(li);
	}
}

// --- Randomize (now client-side) ---

function doRandomize() {
	const raw = $('#names-input').value;
	try {
		const names = validateNames(raw);
		currentAssignments = randomize(names);
		renderAssignments(currentAssignments, $('#assignments-list'));
		$('#assignments-display').classList.remove('hidden');
	} catch (e) {
		showToast(e.message);
	}
}

// --- Fuzzy matching ---

function levenshtein(a, b) {
	const m = a.length, n = b.length;
	const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1]
				? dp[i - 1][j - 1]
				: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

function getUsedNames() {
	return new Set(
		currentAssignments
			.filter((a) => !a.is_ghost)
			.map((a) => a.name.toLowerCase())
	);
}

function abbreviationScore(query, name) {
	const q = query.toLowerCase();
	const nl = name.toLowerCase();
	let ni = 0;
	let score = 0;

	for (let qi = 0; qi < q.length; qi++) {
		let found = false;
		while (ni < name.length) {
			if (nl[ni] === q[qi]) {
				if (ni === 0) {
					score += 10;
				} else {
					const prev = name[ni - 1];
					const curr = name[ni];
					const prevIsLower = prev >= 'a' && prev <= 'z';
					const currIsUpper = curr >= 'A' && curr <= 'Z';
					const prevIsNonAlpha = !/[a-zA-Z]/.test(prev);
					if (prevIsNonAlpha || (prevIsLower && currIsUpper)) {
						score += 10;
					} else {
						score += 1;
					}
				}
				ni++;
				found = true;
				break;
			}
			score -= 1;
			ni++;
		}
		if (!found) return -1;
	}
	return score;
}

function findClosestPlayer(name) {
	if (!knownPlayers.length) return null;
	const lower = name.toLowerCase();

	// For longer names, exact match means no suggestion needed.
	// For short names (<=5 chars), skip this check — they may be
	// abbreviations of a longer canonical player name.
	if (name.length > 5 && knownPlayers.some((p) => p.toLowerCase() === lower)) return null;

	const used = getUsedNames();
	const candidates = knownPlayers.filter((p) => !used.has(p.toLowerCase()));
	if (!candidates.length) return null;

	const prefixMatches = candidates.filter((p) =>
		p.toLowerCase().startsWith(lower)
	);
	if (prefixMatches.length === 1) return prefixMatches[0];

	const substringMatches = candidates.filter((p) =>
		p.toLowerCase().includes(lower)
	);
	if (substringMatches.length === 1) return substringMatches[0];

	const scored = candidates
		.map((p) => ({ name: p, score: abbreviationScore(lower, p) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length === 1) return scored[0].name;
	// Shorter names need less margin — 2-char abbreviations have little
	// signal, so even a small lead is meaningful for a suggestion.
	const margin = name.length <= 2 ? 1 : name.length <= 4 ? 3 : 5;
	if (scored.length >= 2 && scored[0].score >= scored[1].score + margin) {
		return scored[0].name;
	}

	const reversePrefix = candidates.filter((p) =>
		lower.startsWith(p.toLowerCase())
	);
	if (reversePrefix.length === 1) return reversePrefix[0];

	let best = null;
	let bestDist = Infinity;
	for (const p of candidates) {
		const dist = levenshtein(lower, p.toLowerCase());
		if (dist < bestDist) {
			bestDist = dist;
			best = p;
		}
	}
	const maxLen = Math.max(name.length, best.length);
	if (bestDist <= Math.ceil(maxLen / 3)) return best;
	return null;
}

// --- Editable name rendering for record panel ---

function renderEditableAssignments() {
	const listEl = $('#locked-list');
	listEl.innerHTML = '';
	for (const a of currentAssignments) {
		const li = document.createElement('li');
		const posSpan = document.createElement('span');
		posSpan.className = 'pos-num';
		posSpan.textContent = a.position + '.';

		if (a.is_ghost) {
			const nameSpan = document.createElement('span');
			nameSpan.className = 'ghost';
			nameSpan.textContent = `${a.name} (Ghost)`;
			li.appendChild(posSpan);
			li.appendChild(nameSpan);
		} else {
			const nameBtn = document.createElement('button');
			nameBtn.className = a.role === 'Mafia' ? 'name-btn mafia' : 'name-btn town';
			nameBtn.textContent = a.name;
			nameBtn.title = 'Click to edit name';
			nameBtn.addEventListener('click', () => startNameEdit(a, nameBtn));
			li.appendChild(posSpan);
			li.appendChild(nameBtn);

			const exactMatch = knownPlayers.some(
				(p) => p.toLowerCase() === a.name.toLowerCase()
			);
			const suggestion = findClosestPlayer(a.name);

			if (suggestion) {
				const sugBtn = document.createElement('button');
				sugBtn.className = 'name-suggestion-btn';
				sugBtn.innerHTML = `&rarr; ${suggestion}?`;
				sugBtn.title = `Rename to "${suggestion}"`;
				sugBtn.addEventListener('click', () => {
					const oldName = a.name;
					a.name = suggestion;
					renderEditableAssignments();
					rebuildNight0Checks();
					showToast(`Renamed "${oldName}" to "${suggestion}"`, true);
				});
				li.appendChild(sugBtn);
			} else if (exactMatch) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge matched';
				badge.textContent = 'matched';
				li.appendChild(badge);
			} else {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge new-player';
				badge.textContent = 'new player';
				li.appendChild(badge);
			}
		}
		listEl.appendChild(li);
	}
}

function startNameEdit(assignment, btnEl) {
	const wrapper = document.createElement('span');
	wrapper.className = 'name-edit-wrapper';

	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'name-edit-input';
	input.value = assignment.name;

	const suggList = document.createElement('ul');
	suggList.className = 'name-suggestions hidden';

	wrapper.appendChild(input);
	wrapper.appendChild(suggList);
	btnEl.replaceWith(wrapper);

	input.focus();
	input.select();

	let selectedIdx = -1;

	function showSuggestions(query) {
		suggList.innerHTML = '';
		selectedIdx = -1;
		if (!query) {
			suggList.classList.add('hidden');
			return;
		}
		const q = query.toLowerCase();
		const used = getUsedNames();
		used.delete(assignment.name.toLowerCase());
		const matches = knownPlayers
			.filter((p) => {
				const pl = p.toLowerCase();
				return pl.includes(q) && pl !== q && !used.has(pl);
			})
			.slice(0, 8);
		if (!matches.length) {
			suggList.classList.add('hidden');
			return;
		}
		for (const name of matches) {
			const li = document.createElement('li');
			li.textContent = name;
			li.addEventListener('mousedown', (e) => {
				e.preventDefault();
				finishEdit(name);
			});
			suggList.appendChild(li);
		}
		suggList.classList.remove('hidden');
	}

	function updateHighlight() {
		const items = suggList.querySelectorAll('li');
		items.forEach((li, i) => li.classList.toggle('highlighted', i === selectedIdx));
	}

	function finishEdit(newName) {
		const oldName = assignment.name;
		const corrected = correctCase(newName);
		assignment.name = corrected;
		renderEditableAssignments();
		rebuildNight0Checks();
		if (oldName !== corrected) {
			showToast(`Renamed "${oldName}" to "${corrected}"`, true);
		}
	}

	input.addEventListener('input', () => showSuggestions(input.value));

	input.addEventListener('keydown', (e) => {
		const items = suggList.querySelectorAll('li');
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
			updateHighlight();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIdx = Math.max(selectedIdx - 1, -1);
			updateHighlight();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (selectedIdx >= 0 && items[selectedIdx]) {
				finishEdit(items[selectedIdx].textContent);
			} else {
				finishEdit(input.value.trim() || assignment.name);
			}
		} else if (e.key === 'Escape') {
			finishEdit(assignment.name);
		}
	});

	input.addEventListener('blur', () => {
		setTimeout(() => finishEdit(input.value.trim() || assignment.name), 150);
	});
}

function rebuildNight0Checks() {
	const checks = $('#night0-checks');
	const previouslyChecked = new Set(
		[...$$('#night0-checks input:checked')].map((cb) => cb.value)
	);
	checks.innerHTML = '';
	const realPlayers = currentAssignments.filter((a) => !a.is_ghost);
	for (const a of realPlayers) {
		const label = document.createElement('label');
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.value = a.name;
		cb.checked = previouslyChecked.has(a.name);
		cb.addEventListener('change', updateRatedPreview);
		label.appendChild(cb);
		label.appendChild(document.createTextNode(` ${a.name}`));
		checks.appendChild(label);
	}
	updateRatedPreview();
}

// --- Auto-correct names to match spreadsheet ---

function correctCase(name) {
	const lower = name.toLowerCase();
	const match = knownPlayers.find((p) => p.toLowerCase() === lower);
	return match || name;
}

function autoMatchNames() {
	const corrections = [];
	for (const a of currentAssignments) {
		if (a.is_ghost) continue;
		const corrected = correctCase(a.name);
		if (corrected !== a.name) {
			corrections.push(`${a.name} → ${corrected}`);
			a.name = corrected;
		}
	}
	for (const a of currentAssignments) {
		if (a.is_ghost) continue;
		const suggestion = findClosestPlayer(a.name);
		if (suggestion) {
			const score1 = abbreviationScore(a.name.toLowerCase(), suggestion);
			if (score1 >= a.name.length * 8) {
				corrections.push(`${a.name} → ${suggestion}`);
				a.name = suggestion;
			}
		}
	}
	if (corrections.length) {
		showToast(`Auto-matched: ${corrections.join(', ')}`, true);
	}
}

// --- Accept & go to record panel ---

function acceptAssignments() {
	autoMatchNames();
	renderEditableAssignments();
	rebuildNight0Checks();

	$$('input[name="winner"]').forEach((r) => (r.checked = false));
	$('#btn-submit').disabled = true;
	updateRatedPreview();

	showPanel('panel-record');
}

// --- Update rated preview ---

function updateRatedPreview() {
	const n0 = [...$$('#night0-checks input:checked')].map((cb) => cb.value);
	const real = currentAssignments.filter((a) => !a.is_ghost);
	const rated = real.length - n0.length;
	$('#rated-preview').textContent = `${rated} players will be rated`;

	const winner = document.querySelector('input[name="winner"]:checked');
	$('#btn-submit').disabled = !winner;
}

// --- Confirmation dialog ---

function confirmAction(message) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'overlay';
		const dialog = document.createElement('div');
		dialog.className = 'confirm-dialog';
		dialog.innerHTML = `
      <p>${message}</p>
      <div class="button-row">
        <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-ok">Confirm</button>
      </div>
    `;
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		dialog.querySelector('#confirm-ok').addEventListener('click', () => {
			document.body.removeChild(overlay);
			resolve(true);
		});
		dialog.querySelector('#confirm-cancel').addEventListener('click', () => {
			document.body.removeChild(overlay);
			resolve(false);
		});
	});
}

// --- Submit results ---

async function submitResults() {
	const winner = document.querySelector('input[name="winner"]:checked');
	if (!winner) {
		showToast('Select a winner first');
		return;
	}

	const n0 = [...$$('#night0-checks input:checked')].map((cb) => cb.value);

	const confirmed = await confirmAction(
		`Record game: <strong>${winner.value} Win</strong>` +
		(n0.length ? `<br>Night 0 kills: ${n0.join(', ')}` : '') +
		'<br><br>This will update the Google Sheet. Continue?'
	);
	if (!confirmed) return;

	$('#btn-submit').disabled = true;
	try {
		const result = await api('recordGame', {
			assignments: currentAssignments,
			winner: winner.value,
			night0_kills: n0,
		});

		renderResults(result);
		showPanel('panel-results');
		showToast(`Game ${result.game_id} recorded`, true);
		loadLastGame();
	} catch (e) {
		showToast(e.message);
		$('#btn-submit').disabled = false;
	}
}

// --- Render results ---

function renderResults(result) {
	const tbody = $('#results-table tbody');
	tbody.innerHTML = '';

	for (const p of result.players) {
		const tr = document.createElement('tr');
		const changeClass = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
		const alignClass = p.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
		const sign = p.rate_change >= 0 ? '+' : '';

		tr.innerHTML = `
      <td>${p.name}</td>
      <td class="${alignClass}">${p.alignment}</td>
      <td>${p.result}</td>
      <td>${p.old_rating}</td>
      <td>${p.new_rating}</td>
      <td class="${changeClass}">${sign}${p.rate_change}</td>
    `;
		tbody.appendChild(tr);
	}

	const rolesDiv = $('#roles-summary');
	if (result.roles && result.roles.length) {
		const roleLabels = { Mafia: 'align-mafia', Cop: 'role-cop', Medic: 'role-medic', Vigilante: 'role-vig' };
		let html = '<h3>Roles Recorded</h3><div class="roles-list">';
		for (const r of result.roles) {
			const cls = roleLabels[r.role] || '';
			const ghost = r.is_ghost ? ' (Ghost)' : '';
			html += `<span class="role-tag ${cls}">${r.name}${ghost}: ${r.role}</span>`;
		}
		html += '</div>';
		rolesDiv.innerHTML = html;
	} else {
		rolesDiv.innerHTML = '';
	}

	const excl = $('#excluded-summary');
	const parts = [];
	if (result.excluded.ghosts.length) {
		parts.push(`Ghosts: ${result.excluded.ghosts.length}`);
	}
	if (result.excluded.night0_kills.length) {
		parts.push(`Night 0 kills: ${result.excluded.night0_kills.join(', ')}`);
	}
	excl.textContent = parts.length
		? `Excluded from rating: ${parts.join(' | ')}`
		: 'All players rated';
}

// --- Load last game ---

async function loadLastGame() {
	const undoBtn = $('#btn-undo-last');
	try {
		const data = await api('getLastGame');
		const container = $('#last-game-content');
		if (!data.game) {
			container.textContent = 'No games recorded yet';
			undoBtn?.classList.add('hidden');
			return;
		}

		let html = `<p><strong>Game #${data.game.game_id}</strong></p>`;
		html += `<table><thead><tr>
      <th>Player</th><th>Alignment</th><th>Result</th><th>Change</th>
    </tr></thead><tbody>`;

		for (const p of data.game.players) {
			const changeClass = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
			const alignClass = p.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
			const sign = p.rate_change >= 0 ? '+' : '';
			html += `<tr>
        <td>${p.player}</td>
        <td class="${alignClass}">${p.alignment}</td>
        <td>${p.result}</td>
        <td class="${changeClass}">${sign}${p.rate_change}</td>
      </tr>`;
		}
		html += '</tbody></table>';
		container.innerHTML = html;
		undoBtn?.classList.remove('hidden');
	} catch (e) {
		$('#last-game-content').textContent = 'Failed to load last game';
		undoBtn?.classList.add('hidden');
	}
}

// --- Undo last game ---

async function undoLastGame() {
	const confirmed = await confirmAction(
		'Undo the last recorded game?<br><br>This will restore all player ratings to their previous values and delete the game from history.'
	);
	if (!confirmed) return;

	const btn = $('#btn-undo-last');
	btn.disabled = true;
	try {
		const result = await api('undoLastGame');
		showToast(`Game ${result.undone_game_id} undone (${result.players_restored.length} players restored)`, true);
		await loadLastGame();
	} catch (e) {
		showToast(e.message);
	} finally {
		btn.disabled = false;
	}
}

// --- New game ---

function newGame() {
	currentAssignments = null;
	$('#names-input').value = '';
	$('#assignments-display').classList.add('hidden');
	countNames();
	showPanel('panel-randomize');
}

// --- Load player names ---

async function loadPlayerNames() {
	try {
		const data = await api('getPlayers');
		knownPlayers = data.players.map((p) => p.name);
	} catch (e) {
		// Non-critical, autocomplete just won't work
	}
}

// --- Event listeners ---

document.addEventListener('DOMContentLoaded', () => {
	$('#names-input').addEventListener('input', countNames);
	$('#btn-randomize').addEventListener('click', doRandomize);
	$('#btn-reroll').addEventListener('click', doRandomize);
	$('#btn-accept').addEventListener('click', acceptAssignments);
	$('#btn-back').addEventListener('click', () => showPanel('panel-randomize'));
	$('#btn-submit').addEventListener('click', submitResults);
	$('#btn-new-game').addEventListener('click', newGame);
	$('#btn-undo-last')?.addEventListener('click', undoLastGame);

	$$('input[name="winner"]').forEach((r) => {
		r.addEventListener('change', updateRatedPreview);
	});

	loadLastGame();
	loadPlayerNames();
});
