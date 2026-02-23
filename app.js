/* Mafia Randomizer frontend — GitHub Pages + Cloud Function backend */

// Replace with your Cloud Function deployment URL
const SCRIPT_URL = 'https://us-central1-mafia-tracker-310960.cloudfunctions.net/mafia-backend';

const GHOST_NAME = 'Ghost';
const RANDOM_ORG_API_KEY = '93e00e92-f44b-4b59-993a-309ecee52caa';

let randomPool = [];
let poolIndex = 0;

let currentAssignments = null;
let currentFormals = null;
let rollCount = 0;
let knownPlayers = [];
let playerRankMap = new Map();
let nightActions = [];
let vigiHasShot = false;
let dayVotes = {};
let gameMode = 'randomize'; // 'randomize' | 'manual' | 'retroactive'
let manualRoleMap = new Map(); // name → 'Mafia'|'Cop'|'Medic'|'Vigi'
let retroRoleMap = new Map();
let manualNames = [];
let retroNames = [];
let manualSkipMatch = new Set();
let retroSkipMatch = new Set();

const ROLE_CYCLE = ['Town', 'Mafia', 'Cop', 'Medic', 'Vigi'];
const ROLE_LIMITS = { Mafia: 3, Cop: 1, Medic: 1, Vigi: 1 };
const ROLE_CSS = { Town: '', Mafia: 'mafia', Cop: 'cop', Medic: 'medic', Vigi: 'vigi' };

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

// --- API helper ---

async function api(action, data = {}) {
	const resp = await fetch(SCRIPT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, ...data }),
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

// --- Random number pool (random.org with crypto fallback) ---

async function fillRandomPool(n) {
	try {
		const res = await fetch('https://api.random.org/json-rpc/4/invoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'generateDecimalFractions',
				params: {
					apiKey: RANDOM_ORG_API_KEY,
					n,
					decimalPlaces: 14,
					replacement: true,
				},
				id: 1,
			}),
		});
		const data = await res.json();
		if (data.error) throw new Error(data.error.message);
		randomPool = data.result.random.data;
		poolIndex = 0;
	} catch (e) {
		console.warn('random.org unavailable, falling back to crypto:', e.message);
		randomPool = [];
		poolIndex = 0;
		for (let i = 0; i < n; i++) {
			randomPool.push(crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296);
		}
	}
}

function nextRandom() {
	if (poolIndex < randomPool.length) {
		return randomPool[poolIndex++];
	}
	return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function shuffleArray(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom() * (i + 1));
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
	const ghostsInZone2 = Math.min(numGhosts, Math.round(nextRandom()));
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

function buildAssignments(names, roleMap) {
	const mafiaNames = names.filter((n) => roleMap.get(n) === 'Mafia');
	const cop = names.find((n) => roleMap.get(n) === 'Cop');
	const medic = names.find((n) => roleMap.get(n) === 'Medic');
	const vigi = names.find((n) => roleMap.get(n) === 'Vigi');
	const regularTown = names.filter((n) => !roleMap.has(n) || roleMap.get(n) === 'Town');
	const numGhosts = 15 - names.length;

	const assignments = [];
	// Positions 1-3: Mafia
	mafiaNames.forEach((name, i) => {
		assignments.push({ position: i + 1, name, role: 'Mafia', is_ghost: false });
	});
	// Position 4: Cop, 5: Medic, 6: Vigi (or ghost if unassigned)
	[cop, medic, vigi].forEach((name, i) => {
		if (name) {
			assignments.push({ position: i + 4, name, role: 'Town', is_ghost: false });
		} else {
			assignments.push({ position: i + 4, name: GHOST_NAME, role: 'Town', is_ghost: true });
		}
	});
	// Positions 7+: regular town
	regularTown.forEach((name, i) => {
		assignments.push({ position: i + 7, name, role: 'Town', is_ghost: false });
	});
	// Fill remaining with ghosts
	while (assignments.length < 15) {
		assignments.push({
			position: assignments.length + 1,
			name: GHOST_NAME,
			role: 'Town',
			is_ghost: true,
		});
	}
	return assignments;
}

function randomizeFormals() {
	const formals = [];
	for (let day = 1; day <= 8; day++) {
		formals.push({ day, count: Math.floor(nextRandom() * 3) });
	}
	return formals;
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
		} else if (a.position === 4) {
			nameSpan.className = 'cop';
			nameSpan.textContent = `${a.name} (Cop)`;
		} else if (a.position === 5) {
			nameSpan.className = 'medic';
			nameSpan.textContent = `${a.name} (Medic)`;
		} else if (a.position === 6) {
			nameSpan.className = 'vigi';
			nameSpan.textContent = `${a.name} (Vigi)`;
		} else {
			nameSpan.className = 'town';
			nameSpan.textContent = a.name;
		}

		li.appendChild(posSpan);
		li.appendChild(nameSpan);
		listEl.appendChild(li);
	}
}

function renderFormals(formals, el) {
	el.innerHTML = '';
	for (const f of formals) {
		const div = document.createElement('div');
		div.className = 'formal-day';
		const label = document.createElement('span');
		label.className = 'formal-label';
		label.textContent = `Day ${f.day}`;
		const value = document.createElement('span');
		value.className = 'formal-count';
		value.textContent = f.count;
		div.appendChild(label);
		div.appendChild(value);
		el.appendChild(div);
	}
}

// --- Randomize (now client-side) ---

async function doRandomize() {
	const raw = $('#names-input').value;
	try {
		const names = validateNames(raw);
		$('#btn-randomize').disabled = true;
		await fillRandomPool(50);
		$('#btn-randomize').disabled = false;
		currentAssignments = randomize(names);
		currentFormals = randomizeFormals();
		autoMatchNames();
		renderEditableAssignments($('#assignments-list'));
		renderFormals(currentFormals, $('#formals-schedule'));
		rollCount++;
		$('#roll-count').textContent = rollCount;
		$('#assignments-display').classList.remove('hidden');
		saveState();
	} catch (e) {
		$('#btn-randomize').disabled = false;
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

function getUsedNames(names) {
	if (names) return new Set(names.map((n) => n.toLowerCase()));
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

function findClosestPlayer(name, usedNamesOverride) {
	if (!knownPlayers.length) return null;
	const lower = name.toLowerCase();

	// For longer names, exact match means no suggestion needed.
	// For short names (<=5 chars), skip this check — they may be
	// abbreviations of a longer canonical player name.
	if (name.length > 5 && knownPlayers.some((p) => p.toLowerCase() === lower)) return null;

	const used = usedNamesOverride || getUsedNames();
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

function renderEditableAssignments(listEl = $('#locked-list')) {
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
			const posClass = { 4: 'cop', 5: 'medic', 6: 'vigi' };
			nameBtn.className = a.role === 'Mafia'
				? 'name-btn mafia'
				: `name-btn ${posClass[a.position] || 'town'}`;
			nameBtn.textContent = a.name;
			nameBtn.title = 'Click to edit name';
			nameBtn.addEventListener('click', () => startNameEdit(a, nameBtn, listEl));
			li.appendChild(posSpan);
			li.appendChild(nameBtn);

			const exactMatch = knownPlayers.some(
				(p) => p.toLowerCase() === a.name.toLowerCase()
			);
			const suggestion = findClosestPlayer(a.name);

			if (a.skipMatch) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge new-player';
				badge.textContent = 'new player';
				li.appendChild(badge);
			} else if (suggestion) {
				const sugBtn = document.createElement('button');
				sugBtn.className = 'name-suggestion-btn';
				sugBtn.innerHTML = `&rarr; ${suggestion}?`;
				sugBtn.title = `Rename to "${suggestion}"`;
				sugBtn.addEventListener('click', () => {
					const oldName = a.name;
					a.name = suggestion;
					renderEditableAssignments(listEl);
					rebuildNight0Checks();
					saveState();
					showToast(`Renamed "${oldName}" to "${suggestion}"`, true);
				});
				li.appendChild(sugBtn);
			} else if (exactMatch) {
				const badge = document.createElement('span');
				badge.className = 'name-match-badge matched';
				badge.textContent = 'matched';
				li.appendChild(badge);

				const notBtn = document.createElement('button');
				notBtn.className = 'name-notmatch-btn';
				notBtn.textContent = 'not them?';
				notBtn.title = 'Mark as a different player with the same name';
				notBtn.addEventListener('click', () => {
					a.skipMatch = true;
					startNameEdit(a, nameBtn, listEl);
				});
				li.appendChild(notBtn);
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

function createNameEditInput(currentName, getUsedSet, onFinish) {
	const wrapper = document.createElement('span');
	wrapper.className = 'name-edit-wrapper';

	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'name-edit-input';
	input.value = currentName;

	const suggList = document.createElement('ul');
	suggList.className = 'name-suggestions hidden';

	wrapper.appendChild(input);
	wrapper.appendChild(suggList);

	let selectedIdx = -1;
	let finished = false;

	function showSuggestions(query) {
		suggList.innerHTML = '';
		selectedIdx = -1;
		if (!query) {
			suggList.classList.add('hidden');
			return;
		}
		const q = query.toLowerCase();
		const used = getUsedSet();
		used.delete(currentName.toLowerCase());
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
		if (finished) return;
		finished = true;
		onFinish(newName);
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
				finishEdit(input.value.trim() || currentName);
			}
		} else if (e.key === 'Escape') {
			finishEdit(currentName);
		}
	});

	input.addEventListener('blur', () => {
		setTimeout(() => finishEdit(input.value.trim() || currentName), 150);
	});

	return wrapper;
}

function startNameEdit(assignment, btnEl, listEl) {
	const wrapper = createNameEditInput(
		assignment.name,
		() => getUsedNames(),
		(newName) => {
			const oldName = assignment.name;
			const corrected = correctCase(newName);
			assignment.name = corrected;
			delete assignment.skipMatch;
			renderEditableAssignments(listEl);
			rebuildNight0Checks();
			saveState();
			if (oldName !== corrected) {
				showToast(`Renamed "${oldName}" to "${corrected}"`, true);
			}
		}
	);
	btnEl.replaceWith(wrapper);
	wrapper.querySelector('input').focus();
	wrapper.querySelector('input').select();
}

function startManualNameEdit(nameIndex, names, btnEl, containerId, roleMap, onChange, skipMatchSet) {
	const wrapper = createNameEditInput(
		names[nameIndex],
		() => getUsedNames(names),
		(newName) => {
			const oldName = names[nameIndex];
			const corrected = correctCase(newName);
			if (oldName !== corrected) {
				// Re-key roleMap
				if (roleMap.has(oldName)) {
					roleMap.set(corrected, roleMap.get(oldName));
					roleMap.delete(oldName);
				}
				// Update skipMatch set
				if (skipMatchSet.has(oldName)) {
					skipMatchSet.delete(oldName);
					skipMatchSet.add(corrected);
				}
				names[nameIndex] = corrected;
				// For retro: preserve N0 checkbox state across rebuild
				if (containerId === 'retro-player-list') {
					const checkedN0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
					const updatedChecked = checkedN0.map((n) => n === oldName ? corrected : n);
					buildRetroN0Checks();
					$$('#retro-n0-checks input[type="checkbox"]').forEach((cb) => {
						cb.checked = updatedChecked.includes(cb.value);
					});
				}
				showToast(`Renamed "${oldName}" to "${corrected}"`, true);
			}
			renderManualPlayerList(names, containerId, roleMap, onChange, skipMatchSet);
			onChange();
			saveState();
		}
	);
	btnEl.replaceWith(wrapper);
	wrapper.querySelector('input').focus();
	wrapper.querySelector('input').select();
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
		cb.addEventListener('change', () => { updateRatedPreview(); saveState(); });
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
	rollCount = 0;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};

	$('#role-reveal-pre').textContent = generateRoleReveal();
	$('#nights-container').innerHTML = '';
	addNightSection(0);
	updateNightButtons();

	showPanel('panel-game');
	saveState();
}

// --- Manual Setup & Retroactive Entry ---

function getRoleCounts(roleMap) {
	const counts = { Mafia: 0, Cop: 0, Medic: 0, Vigi: 0 };
	for (const role of roleMap.values()) counts[role] = (counts[role] || 0) + 1;
	return counts;
}

function roleCounterText(roleMap) {
	const c = getRoleCounts(roleMap);
	return `${c.Mafia}/3 Mafia · ${c.Cop}/1 Cop · ${c.Medic}/1 Medic · ${c.Vigi}/1 Vigi`;
}

function isRoleSelectionComplete(roleMap) {
	const c = getRoleCounts(roleMap);
	return c.Mafia === 3 && c.Cop === 1 && c.Medic === 1 && c.Vigi === 1;
}

function renderManualPlayerList(names, containerId, roleMap, onChange, skipMatchSet) {
	const container = $(`#${containerId}`);
	container.innerHTML = '';
	const used = getUsedNames(names);

	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const item = document.createElement('div');
		item.className = 'manual-player-item';

		// Name button — click to inline edit
		const nameBtn = document.createElement('button');
		nameBtn.type = 'button';
		nameBtn.className = 'player-name-btn';
		nameBtn.textContent = name;
		nameBtn.title = 'Click to edit name';
		nameBtn.addEventListener('click', () => {
			startManualNameEdit(i, names, nameBtn, containerId, roleMap, onChange, skipMatchSet);
		});
		item.appendChild(nameBtn);

		// Name matching badges/suggestions
		const exactMatch = knownPlayers.some((p) => p.toLowerCase() === name.toLowerCase());
		const suggestion = skipMatchSet.has(name) ? null : findClosestPlayer(name, used);

		if (skipMatchSet.has(name)) {
			const badge = document.createElement('span');
			badge.className = 'name-match-badge new-player';
			badge.textContent = 'new player';
			item.appendChild(badge);
		} else if (suggestion) {
			const sugBtn = document.createElement('button');
			sugBtn.type = 'button';
			sugBtn.className = 'name-suggestion-btn';
			sugBtn.innerHTML = `&rarr; ${suggestion}?`;
			sugBtn.title = `Rename to "${suggestion}"`;
			sugBtn.addEventListener('click', () => {
				const oldName = names[i];
				if (roleMap.has(oldName)) {
					roleMap.set(suggestion, roleMap.get(oldName));
					roleMap.delete(oldName);
				}
				names[i] = suggestion;
				if (containerId === 'retro-player-list') {
					const checkedN0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
					const updatedChecked = checkedN0.map((n) => n === oldName ? suggestion : n);
					buildRetroN0Checks();
					$$('#retro-n0-checks input[type="checkbox"]').forEach((cb) => {
						cb.checked = updatedChecked.includes(cb.value);
					});
				}
				renderManualPlayerList(names, containerId, roleMap, onChange, skipMatchSet);
				onChange();
				saveState();
				showToast(`Renamed "${oldName}" to "${suggestion}"`, true);
			});
			item.appendChild(sugBtn);
		} else if (exactMatch) {
			const badge = document.createElement('span');
			badge.className = 'name-match-badge matched';
			badge.textContent = 'matched';
			item.appendChild(badge);

			const notBtn = document.createElement('button');
			notBtn.type = 'button';
			notBtn.className = 'name-notmatch-btn';
			notBtn.textContent = 'not them?';
			notBtn.title = 'Mark as a different player with the same name';
			notBtn.addEventListener('click', () => {
				skipMatchSet.add(name);
				startManualNameEdit(i, names, nameBtn, containerId, roleMap, onChange, skipMatchSet);
			});
			item.appendChild(notBtn);
		} else {
			const badge = document.createElement('span');
			badge.className = 'name-match-badge new-player';
			badge.textContent = 'new player';
			item.appendChild(badge);
		}

		// Role button — click to cycle role
		const roleBtn = document.createElement('button');
		roleBtn.type = 'button';
		const currentRole = roleMap.get(name) || 'Town';
		roleBtn.className = 'player-toggle' + (ROLE_CSS[currentRole] ? ` ${ROLE_CSS[currentRole]}` : '');
		roleBtn.textContent = currentRole;
		roleBtn.addEventListener('click', () => {
			const role = roleMap.get(name) || 'Town';
			const idx = ROLE_CYCLE.indexOf(role);
			for (let step = 1; step <= ROLE_CYCLE.length; step++) {
				const next = ROLE_CYCLE[(idx + step) % ROLE_CYCLE.length];
				if (next === 'Town') {
					roleMap.delete(name);
					roleBtn.className = 'player-toggle';
					roleBtn.textContent = 'Town';
					break;
				}
				const counts = getRoleCounts(roleMap);
				if (counts[next] < ROLE_LIMITS[next]) {
					roleMap.set(name, next);
					roleBtn.className = 'player-toggle ' + ROLE_CSS[next];
					roleBtn.textContent = next;
					break;
				}
			}
			onChange();
		});
		item.appendChild(roleBtn);

		container.appendChild(item);
	}
}

function doManualSetup() {
	const raw = $('#names-input').value;
	try {
		manualNames = validateNames(raw);
		for (let i = 0; i < manualNames.length; i++) manualNames[i] = correctCase(manualNames[i]);
		gameMode = 'manual';
		manualRoleMap = new Map();
		manualSkipMatch = new Set();

		$('#assignments-display').classList.add('hidden');
		$('#retro-form').classList.add('hidden');
		$('#manual-setup').classList.remove('hidden');

		renderManualPlayerList(manualNames, 'manual-player-list', manualRoleMap, () => {
			$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
			$('#btn-manual-accept').disabled = !isRoleSelectionComplete(manualRoleMap);
			saveState();
		}, manualSkipMatch);

		$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
		$('#btn-manual-accept').disabled = true;
		saveState();
	} catch (e) {
		showToast(e.message);
	}
}

function acceptManualSetup() {
	currentAssignments = buildAssignments(manualNames, manualRoleMap);
	currentFormals = null;
	autoMatchNames();

	rollCount = 0;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};

	$('#role-reveal-pre').textContent = generateRoleReveal();
	$('#nights-container').innerHTML = '';
	addNightSection(0);
	updateNightButtons();

	$('#manual-setup').classList.add('hidden');
	showPanel('panel-game');
	saveState();
}

function doRetroEntry() {
	const raw = $('#names-input').value;
	try {
		retroNames = validateNames(raw);
		for (let i = 0; i < retroNames.length; i++) retroNames[i] = correctCase(retroNames[i]);
		gameMode = 'retroactive';
		retroRoleMap = new Map();
		retroSkipMatch = new Set();

		$('#assignments-display').classList.add('hidden');
		$('#manual-setup').classList.add('hidden');
		$('#retro-form').classList.remove('hidden');

		renderManualPlayerList(retroNames, 'retro-player-list', retroRoleMap, () => {
			updateRetroForm();
			saveState();
		}, retroSkipMatch);

		$$('input[name="retro-winner"]').forEach((r) => (r.checked = false));
		buildRetroN0Checks();
		$('#retro-mafia-counter').textContent = roleCounterText(retroRoleMap);
		$('#retro-rated-preview').textContent = `${retroNames.length} players will be rated`;
		$('#btn-retro-submit').disabled = true;
		saveState();
	} catch (e) {
		showToast(e.message);
	}
}

function buildRetroN0Checks() {
	const checks = $('#retro-n0-checks');
	checks.innerHTML = '';
	for (const name of retroNames) {
		const label = document.createElement('label');
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.value = name;
		cb.addEventListener('change', () => { updateRetroForm(); saveState(); });
		label.appendChild(cb);
		label.appendChild(document.createTextNode(` ${name}`));
		checks.appendChild(label);
	}
}

function updateRetroForm() {
	$('#retro-mafia-counter').textContent = roleCounterText(retroRoleMap);

	const n0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
	const rated = retroNames.length - n0.length;
	$('#retro-rated-preview').textContent = `${rated} players will be rated`;

	const winner = document.querySelector('input[name="retro-winner"]:checked');
	$('#btn-retro-submit').disabled = !(isRoleSelectionComplete(retroRoleMap) && winner);
}

async function submitRetroGame() {
	const winner = document.querySelector('input[name="retro-winner"]:checked');
	if (!winner || !isRoleSelectionComplete(retroRoleMap)) return;

	const n0 = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);

	currentAssignments = buildAssignments(retroNames, retroRoleMap);
	autoMatchNames();

	const confirmed = await confirmAction(
		`Record past game: <strong>${winner.value} Win</strong>` +
		(n0.length ? `<br>Night 0 kills: ${n0.join(', ')}` : '') +
		'<br><br>This will update the Google Sheet. Continue?'
	);
	if (!confirmed) return;

	$('#btn-retro-submit').disabled = true;
	try {
		const result = await api('recordGame', {
			assignments: currentAssignments,
			winner: winner.value,
			night0_kills: n0,
		});

		clearSavedState();
		gameMode = 'randomize';
		await loadPlayerNames();
		renderResults(result);
		showPanel('panel-results');
		showToast(`Game ${result.game_id} recorded`, true);
		loadLastGame();
	} catch (e) {
		showToast(e.message);
		$('#btn-retro-submit').disabled = false;
	}
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

		clearSavedState();
		await loadPlayerNames();
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

	const medals = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };
	const rankClass = (r) => {
		if (r === 1) return 'rank-gold';
		if (r === 2) return 'rank-silver';
		if (r === 3) return 'rank-bronze';
		if (r <= 15) return 'rank-top15';
		return '';
	};

	for (const p of result.players) {
		const tr = document.createElement('tr');
		const alignClass = p.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
		const isExcluded = p.result === 'Ghost' || p.result === 'Night Zero';

		if (isExcluded) {
			tr.innerHTML = `
      <td>-</td>
      <td>${p.name}</td>
      <td class="${alignClass}">${p.alignment}</td>
      <td>${p.result}</td>
      <td>-</td>
      <td>-</td>
      <td>0</td>
    `;
			tr.classList.add('excluded-row');
		} else {
			const changeClass = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
			const resultClass = p.result === 'Win' ? 'change-pos' : 'change-neg';
			const sign = p.rate_change >= 0 ? '+' : '';
			const rank = playerRankMap.get(p.name) ?? '-';
			const rc = typeof rank === 'number' ? rankClass(rank) : '';
			tr.innerHTML = `
      <td class="${rc}">${medals[rank] || rank}</td>
      <td>${p.name}</td>
      <td class="${alignClass}">${p.alignment}</td>
      <td class="${resultClass}">${p.result}</td>
      <td>${p.old_rating}</td>
      <td>${p.new_rating}</td>
      <td class="${changeClass}">${sign}${p.rate_change}</td>
    `;
		}
		tbody.appendChild(tr);
	}

	const rolesDiv = $('#roles-summary');
	rolesDiv.innerHTML = '';

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

		const medals = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };
		const rankClass = (r) => {
			if (r === 1) return 'rank-gold';
			if (r === 2) return 'rank-silver';
			if (r === 3) return 'rank-bronze';
			if (r <= 15) return 'rank-top15';
			return '';
		};

		let html = `<p><strong>Game #${data.game.game_id}</strong></p>`;
		html += `<table><thead><tr>
      <th>#</th><th>Player</th><th>Alignment</th><th>Result</th><th>Rating</th><th>Change</th>
    </tr></thead><tbody>`;

		for (const p of data.game.players) {
			const alignClass = p.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
			const isExcluded = p.result === 'Ghost' || p.result === 'Night Zero';
			if (isExcluded) {
				html += `<tr class="excluded-row">
        <td>-</td>
        <td>${p.player}</td>
        <td class="${alignClass}">${p.alignment}</td>
        <td>${p.result}</td>
        <td>-</td>
        <td>0</td>
      </tr>`;
			} else {
				const changeClass = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
				const resultClass = p.result === 'Win' ? 'change-pos' : 'change-neg';
				const sign = p.rate_change >= 0 ? '+' : '';
				const rank = playerRankMap.get(p.player) ?? '-';
				const rc = typeof rank === 'number' ? rankClass(rank) : '';
				html += `<tr>
        <td class="${rc}">${medals[rank] || rank}</td>
        <td>${p.player}</td>
        <td class="${alignClass}">${p.alignment}</td>
        <td class="${resultClass}">${p.result}</td>
        <td>${p.new_rating}</td>
        <td class="${changeClass}">${sign}${p.rate_change}</td>
      </tr>`;
			}
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
		await loadPlayerNames();
		await loadLastGame();
	} catch (e) {
		showToast(e.message);
	} finally {
		btn.disabled = false;
	}
}

// --- New game ---

function newGame() {
	clearSavedState();
	currentAssignments = null;
	currentFormals = null;
	nightActions = [];
	vigiHasShot = false;
	dayVotes = {};
	gameMode = 'randomize';
	manualRoleMap = new Map();
	retroRoleMap = new Map();
	manualNames = [];
	retroNames = [];
	manualSkipMatch = new Set();
	retroSkipMatch = new Set();
	$('#names-input').value = '';
	$('#assignments-display').classList.add('hidden');
	$('#manual-setup').classList.add('hidden');
	$('#retro-form').classList.add('hidden');
	$('#nights-container').innerHTML = '';
	countNames();
	showPanel('panel-randomize');
}

// --- Load player names ---

async function loadPlayerNames() {
	try {
		const data = await api('getPlayers');
		knownPlayers = data.players.map((p) => p.name);
		const byRating = [...data.players].sort((a, b) => b.rating - a.rating);
		playerRankMap = new Map();
		byRating.forEach((p, i) => playerRankMap.set(p.name, i + 1));
	} catch (e) {
		// Non-critical, autocomplete just won't work
	}
}

// --- Night Actions & Game Panel ---

function getAlignment(name) {
	const a = currentAssignments.find((p) => p.name === name);
	return a ? a.role : null;
}

function generateRoleReveal() {
	const mafia = currentAssignments.filter((a) => a.position <= 3).map((a) => a.name);
	const cop = currentAssignments.find((a) => a.position === 4);
	const medic = currentAssignments.find((a) => a.position === 5);
	const vigi = currentAssignments.find((a) => a.position === 6);

	return [
		`Mafia: ||${mafia.join(', ')}||`,
		`Cop: ||${cop.name}||`,
		`Medic: ||${medic.name}||`,
		`Vigi: ||${vigi.name}||`,
	].join('\n');
}

function createPlayerSelect(players, placeholder) {
	const sel = document.createElement('select');
	sel.className = 'night-select';

	const defaultOpt = document.createElement('option');
	defaultOpt.value = '';
	defaultOpt.textContent = placeholder;
	sel.appendChild(defaultOpt);

	for (const p of players) {
		const opt = document.createElement('option');
		opt.value = p.name;
		opt.textContent = p.name;
		sel.appendChild(opt);
	}

	return sel;
}

function calculateCopResult(target, nightIndex) {
	if (nightIndex === 0 || !target) return null;

	let prevCheck = null;
	for (let i = nightIndex - 1; i >= 0; i--) {
		if (nightActions[i] && nightActions[i].copCheck) {
			prevCheck = nightActions[i].copCheck;
			break;
		}
	}
	if (!prevCheck) return null;

	const targetAlignment = getAlignment(target);
	const prevAlignment = getAlignment(prevCheck);
	if (!targetAlignment || !prevAlignment) return null;

	return targetAlignment === prevAlignment ? 'SAME' : 'DIFFERENT';
}

function updateCopBadge(nightIndex) {
	const nd = nightActions[nightIndex];
	const badge = $(`#cop-badge-${nd.night}`);
	if (!badge) return;

	if (nd.copResult) {
		badge.textContent = nd.copResult;
		badge.className = `cop-result-badge ${nd.copResult.toLowerCase()}`;
	} else {
		badge.textContent = '';
		badge.className = 'cop-result-badge';
	}
}

function recalculateCopResults(fromIndex) {
	for (let i = fromIndex; i < nightActions.length; i++) {
		const nd = nightActions[i];
		nd.copResult = calculateCopResult(nd.copCheck, i);
		updateCopBadge(i);
		updateNightOutput(nd.night);
	}
}

function generateNightOutput(nightData) {
	const kills = [...new Set(nightData.mafKills.filter(Boolean))];
	let output = '';

	if (kills.length) {
		output += `mafia: ||killed ${kills.join(', ')}||\n`;
	}

	if (nightData.copCheck) {
		if (nightData.night > 0 && nightData.copResult) {
			let prevTarget = null;
			for (let i = nightData.night - 1; i >= 0; i--) {
				if (nightActions[i] && nightActions[i].copCheck) {
					prevTarget = nightActions[i].copCheck;
					break;
				}
			}
			if (prevTarget) {
				output += `cop: ||check ${nightData.copCheck} - ${nightData.copResult} to ${prevTarget}||\n`;
			} else {
				output += `cop: ||check ${nightData.copCheck}||\n`;
			}
		} else {
			output += `cop: ||check ${nightData.copCheck}||\n`;
		}
	}

	if (nightData.medicSave) {
		output += `medic: ||saved ${nightData.medicSave}||\n`;
	}

	if (nightData.vigiTarget) {
		output += `vigi: ||shot ${nightData.vigiTarget}||\n`;
	} else if (nightData.vigiActive) {
		output += `vigi: ||holstered||\n`;
	}

	if (nightData.rngs) {
		output += `rngs: ${nightData.rngs}`;
	}

	return output.trimEnd();
}

function updateNightOutput(nightNum) {
	const nightData = nightActions.find((n) => n.night === nightNum);
	if (!nightData) return;

	const pre = $(`#night-output-${nightNum}`);
	if (pre) {
		pre.textContent = generateNightOutput(nightData);
	}
}

function handleCopyClick(e) {
	const btn = e.target.closest('.btn-copy');
	if (!btn) return;

	const targetId = btn.dataset.target;
	const pre = document.getElementById(targetId);
	if (!pre) return;

	navigator.clipboard.writeText(pre.textContent).then(() => {
		btn.textContent = 'Copied!';
		btn.classList.add('copied');
		setTimeout(() => {
			btn.textContent = 'Copy';
			btn.classList.remove('copied');
		}, 2000);
	});
}

function updateNightButtons() {
	const container = $('#night-buttons');
	container.innerHTML = '';
	const gameOver = !!checkWinCondition();
	for (let i = 0; i <= 7; i++) {
		const btn = document.createElement('button');
		btn.className = 'btn-night';
		btn.textContent = `N${i}`;
		btn.dataset.night = i;

		if (i < nightActions.length) {
			btn.disabled = true;
			btn.classList.add('used');
		} else if (i === nightActions.length && !gameOver) {
			btn.addEventListener('click', () => {
				addNightSection(i);
				updateNightButtons();
			});
		} else {
			btn.disabled = true;
		}

		container.appendChild(btn);
	}
}

function checkWinCondition() {
	if (!currentAssignments) return null;

	const dead = new Set();
	for (let i = 0; i < nightActions.length; i++) addNightKills(dead, i);
	for (const name of Object.values(dayVotes)) {
		if (name) dead.add(name);
	}

	const mafia = currentAssignments.filter((a) => a.role === 'Mafia');
	const town = currentAssignments.filter((a) => a.role !== 'Mafia' && !a.is_ghost);
	const aliveMafia = mafia.filter((a) => !dead.has(a.name)).length;
	const aliveTown = town.filter((a) => !dead.has(a.name)).length;

	if (aliveMafia === 0) return { winner: 'Town', mafia: aliveMafia, town: aliveTown };
	if (aliveMafia >= aliveTown) return { winner: 'Mafia', mafia: aliveMafia, town: aliveTown };
	return null;
}

function updateWinIndicator() {
	const result = checkWinCondition();
	const el = $('#win-indicator');
	if (!el) return;

	if (result) {
		const cls = result.winner === 'Mafia' ? 'mafia-win' : 'town-win';
		el.textContent = `${result.winner} wins! (${result.mafia} mafia vs ${result.town} town)`;
		el.className = `win-indicator ${cls}`;
	} else {
		el.className = 'win-indicator hidden';
	}
}

function addNightKills(deadSet, nightIndex) {
	const nd = nightActions[nightIndex];
	if (!nd) return;
	for (const kill of nd.mafKills) {
		if (kill && kill !== nd.medicSave) deadSet.add(kill);
	}
	if (nd.vigiTarget) deadSet.add(nd.vigiTarget);
}

function getDeadBeforeNight(n) {
	const dead = new Set();
	for (let i = 0; i < n; i++) addNightKills(dead, i);
	for (let d = 1; d <= n; d++) {
		if (dayVotes[d]) dead.add(dayVotes[d]);
	}
	return dead;
}

function getDeadBeforeDay(d) {
	const dead = new Set();
	for (let i = 0; i < d; i++) addNightKills(dead, i);
	for (let dd = 1; dd < d; dd++) {
		if (dayVotes[dd]) dead.add(dayVotes[dd]);
	}
	return dead;
}

function refreshConstraints() {
	const cop = currentAssignments.find((a) => a.position === 4);
	const medic = currentAssignments.find((a) => a.position === 5);
	const vigi = currentAssignments.find((a) => a.position === 6);
	vigiHasShot = nightActions.some((nd) => nd.vigiShot);

	for (let n = 0; n < nightActions.length; n++) {
		const nd = nightActions[n];
		const dead = getDeadBeforeNight(n);

		// Show/hide mafia kills based on alive count and N0 player count
		const mafiaNames = currentAssignments.filter((a) => a.role === 'Mafia').map((a) => a.name);
		const aliveMafia = mafiaNames.filter((name) => !dead.has(name)).length;
		const realCount = currentAssignments.filter((a) => !a.is_ghost).length;

		const mafKill1Wrapper = $(`.maf-kill-1-wrapper[data-night="${n}"]`);
		const mafKill2Wrapper = $(`.maf-kill-2-wrapper[data-night="${n}"]`);

		// Kill 1: hidden only on N0 with 13 players
		if (mafKill1Wrapper) {
			if (n === 0 && realCount <= 13) {
				mafKill1Wrapper.classList.add('hidden');
				nd.mafKills[0] = '';
			} else {
				mafKill1Wrapper.classList.remove('hidden');
			}
		}

		// Kill 2: hidden if <3 mafia alive OR N0 with <15 players
		if (mafKill2Wrapper) {
			if (aliveMafia < 3 || (n === 0 && realCount < 15)) {
				mafKill2Wrapper.classList.add('hidden');
				const mafSel2 = mafKill2Wrapper.querySelector('.maf-select');
				if (mafSel2) {
					mafSel2.value = '';
					nd.mafKills[1] = '';
				}
			} else {
				mafKill2Wrapper.classList.remove('hidden');
			}
		}

		// N0: no vigi shot, no medic save with 13 players
		const vigiWrap = $(`.vigi-wrapper[data-night="${n}"]`);
		if (vigiWrap) {
			if (n === 0) {
				vigiWrap.classList.add('hidden');
				nd.vigiTarget = '';
				nd.vigiShot = false;
			} else {
				vigiWrap.classList.remove('hidden');
			}
		}

		const medicWrap = $(`.medic-wrapper[data-night="${n}"]`);
		if (medicWrap) {
			if (n === 0 && realCount <= 13) {
				medicWrap.classList.add('hidden');
				nd.medicSave = '';
			} else {
				medicWrap.classList.remove('hidden');
			}
		}

		// Update day vote select (Day n precedes Night n)
		if (n > 0) {
			const daySel = $(`.day-vote-select[data-day="${n}"]`);
			if (daySel) {
				const dayDead = getDeadBeforeDay(n);
				daySel.querySelectorAll('option').forEach((opt) => {
					opt.disabled = opt.value !== '' && dayDead.has(opt.value);
				});
				if (dayDead.has(daySel.value)) {
					daySel.value = '';
					dayVotes[n] = '';
				}
			}
		}

		// Collect all night selects for this night
		const allSels = [
			...$$(`[data-night="${n}"].maf-select`),
			$(`.cop-select[data-night="${n}"]`),
			$(`.medic-select[data-night="${n}"]`),
			$(`.vigi-select[data-night="${n}"]`),
		].filter(Boolean);

		// Enable all options first
		for (const sel of allSels) {
			sel.disabled = false;
			sel.querySelectorAll('option').forEach((opt) => {
				opt.disabled = false;
			});
		}

		// Disable dead players in all selects
		for (const sel of allSels) {
			sel.querySelectorAll('option').forEach((opt) => {
				if (opt.value !== '' && dead.has(opt.value)) opt.disabled = true;
			});
		}

		// Cop no-repeat constraint
		const copSel = $(`.cop-select[data-night="${n}"]`);
		if (copSel) {
			const usedChecks = new Set();
			for (let j = 0; j < n; j++) {
				if (nightActions[j].copCheck) usedChecks.add(nightActions[j].copCheck);
			}
			copSel.querySelectorAll('option').forEach((opt) => {
				if (opt.value !== '' && usedChecks.has(opt.value)) opt.disabled = true;
			});
		}

		// Medic no-consecutive constraint
		const medicSel = $(`.medic-select[data-night="${n}"]`);
		if (medicSel) {
			const prevSave = n > 0 ? nightActions[n - 1].medicSave : '';
			if (prevSave) {
				medicSel.querySelectorAll('option').forEach((opt) => {
					if (opt.value === prevSave) opt.disabled = true;
				});
			}
		}

		// Role holder death — disable entire select if holder is dead
		if (cop && !cop.is_ghost && dead.has(cop.name) && copSel) {
			copSel.disabled = true;
			copSel.value = '';
			nd.copCheck = '';
		}
		if (medic && !medic.is_ghost && dead.has(medic.name) && medicSel) {
			medicSel.disabled = true;
			medicSel.value = '';
			nd.medicSave = '';
		}
		const vigiSel = $(`.vigi-select[data-night="${n}"]`);
		if (vigi && !vigi.is_ghost && dead.has(vigi.name) && vigiSel) {
			vigiSel.disabled = true;
			vigiSel.value = '';
			nd.vigiTarget = '';
			nd.vigiShot = false;
		}

		// Vigi one-shot constraint
		if (vigiSel && !vigiSel.disabled) {
			if (vigiHasShot && !nd.vigiShot) {
				vigiSel.disabled = true;
			}
		}
		const spentEl = $(`#vigi-spent-${n}`);
		if (spentEl) {
			const showSpent = vigiSel && vigiSel.disabled && !(vigi && dead.has(vigi.name));
			spentEl.classList.toggle('hidden', !showSpent);
		}

		// Reset invalid selections (current value is disabled)
		for (const sel of allSels) {
			if (sel.disabled) continue;
			const chosen = sel.querySelector(`option[value="${CSS.escape(sel.value)}"]`);
			if (chosen && chosen.disabled) {
				sel.value = '';
				// Sync back to data model
				if (sel.classList.contains('maf-select')) {
					nd.mafKills[parseInt(sel.dataset.kill)] = '';
				} else if (sel.classList.contains('cop-select')) {
					nd.copCheck = '';
				} else if (sel.classList.contains('medic-select')) {
					nd.medicSave = '';
				} else if (sel.classList.contains('vigi-select')) {
					nd.vigiTarget = '';
					nd.vigiShot = false;
				}
			}
		}

		nd.vigiActive = n > 0 && vigiSel && !vigiSel.disabled;
		updateNightOutput(n);
	}

	// Recalculate vigiHasShot after potential resets
	vigiHasShot = nightActions.some((nd) => nd.vigiShot);
	recalculateCopResults(0);
	updateWinIndicator();
	updateNightButtons();
	saveState();
}

function addDaySection(dayNum) {
	const allReal = currentAssignments.filter((a) => !a.is_ghost);
	dayVotes[dayNum] = '';

	const section = document.createElement('div');
	section.className = 'day-section';
	section.dataset.day = dayNum;

	const heading = document.createElement('h3');
	heading.textContent = `Day ${dayNum}`;
	section.appendChild(heading);

	const label = document.createElement('label');
	label.className = 'night-label';
	label.textContent = 'Voted Out';
	section.appendChild(label);

	const sel = createPlayerSelect(allReal, 'No one');
	sel.classList.add('day-vote-select');
	sel.dataset.day = dayNum;
	sel.addEventListener('change', () => {
		dayVotes[dayNum] = sel.value;
		refreshConstraints();
	});
	section.appendChild(sel);

	$('#nights-container').appendChild(section);
}

function addNightSection(nightNum) {
	const nonMafia = currentAssignments.filter((a) => !a.is_ghost && a.role !== 'Mafia');
	const allReal = currentAssignments.filter((a) => !a.is_ghost);
	const copTargets = allReal.filter((a) => a.position !== 4);
	const medicTargets = allReal.filter((a) => a.position !== 5);
	const vigiTargets = allReal.filter((a) => a.position !== 6);

	// Insert day section before night (except N0)
	if (nightNum > 0) {
		addDaySection(nightNum);
	}

	const nightData = {
		night: nightNum,
		mafKills: ['', ''],
		copCheck: '',
		copResult: null,
		medicSave: '',
		vigiTarget: '',
		vigiShot: false,
		vigiActive: false,
		rngs: '',
	};
	nightActions.push(nightData);

	const section = document.createElement('div');
	section.className = 'night-section';

	const heading = document.createElement('h3');
	heading.textContent = `Night ${nightNum}`;
	section.appendChild(heading);

	// Mafia Kill 1
	const mafKill1Wrapper = document.createElement('div');
	mafKill1Wrapper.className = 'maf-kill-1-wrapper';
	mafKill1Wrapper.dataset.night = nightNum;

	const mafLabel1 = document.createElement('label');
	mafLabel1.className = 'night-label';
	mafLabel1.textContent = 'Mafia Kill 1';
	mafKill1Wrapper.appendChild(mafLabel1);

	const mafSel1 = createPlayerSelect(nonMafia, 'Select target...');
	mafSel1.classList.add('maf-select');
	mafSel1.dataset.night = nightNum;
	mafSel1.dataset.kill = '0';
	mafSel1.addEventListener('change', () => {
		nightData.mafKills[0] = mafSel1.value;
		refreshConstraints();
	});
	mafKill1Wrapper.appendChild(mafSel1);

	section.appendChild(mafKill1Wrapper);

	// Mafia Kill 2 (only available when 3 mafia alive)
	const mafKill2Wrapper = document.createElement('div');
	mafKill2Wrapper.className = 'maf-kill-2-wrapper';
	mafKill2Wrapper.dataset.night = nightNum;

	const mafLabel2 = document.createElement('label');
	mafLabel2.className = 'night-label';
	mafLabel2.textContent = 'Mafia Kill 2';
	mafKill2Wrapper.appendChild(mafLabel2);

	const mafSel2 = createPlayerSelect(nonMafia, 'Select target...');
	mafSel2.classList.add('maf-select');
	mafSel2.dataset.night = nightNum;
	mafSel2.dataset.kill = '1';
	mafSel2.addEventListener('change', () => {
		nightData.mafKills[1] = mafSel2.value;
		refreshConstraints();
	});
	mafKill2Wrapper.appendChild(mafSel2);

	section.appendChild(mafKill2Wrapper);

	// Cop Check
	const copLabel = document.createElement('label');
	copLabel.className = 'night-label';
	copLabel.textContent = 'Cop Check';
	section.appendChild(copLabel);

	const copRow = document.createElement('div');
	copRow.className = 'night-field-row';

	const copSel = createPlayerSelect(copTargets, 'Select target...');
	copSel.classList.add('cop-select');
	copSel.dataset.night = nightNum;
	copSel.addEventListener('change', () => {
		nightData.copCheck = copSel.value;
		refreshConstraints();
	});
	copRow.appendChild(copSel);

	const copBadge = document.createElement('span');
	copBadge.className = 'cop-result-badge';
	copBadge.id = `cop-badge-${nightNum}`;
	copRow.appendChild(copBadge);

	section.appendChild(copRow);

	// Medic Save
	const medicWrapper = document.createElement('div');
	medicWrapper.className = 'medic-wrapper';
	medicWrapper.dataset.night = nightNum;

	const medicLabel = document.createElement('label');
	medicLabel.className = 'night-label';
	medicLabel.textContent = 'Medic Save';
	medicWrapper.appendChild(medicLabel);

	const medicSel = createPlayerSelect(medicTargets, 'Select target...');
	medicSel.classList.add('medic-select');
	medicSel.dataset.night = nightNum;
	medicSel.addEventListener('change', () => {
		nightData.medicSave = medicSel.value;
		refreshConstraints();
	});
	medicWrapper.appendChild(medicSel);

	section.appendChild(medicWrapper);

	// Vigilante
	const vigiWrapper = document.createElement('div');
	vigiWrapper.className = 'vigi-wrapper';
	vigiWrapper.dataset.night = nightNum;

	const vigiLabel = document.createElement('label');
	vigiLabel.className = 'night-label';
	vigiLabel.textContent = 'Vigilante';
	vigiWrapper.appendChild(vigiLabel);

	const vigiRow = document.createElement('div');
	vigiRow.className = 'night-field-row';

	const vigiSel = createPlayerSelect(vigiTargets, 'Holster');
	vigiSel.classList.add('vigi-select');
	vigiSel.dataset.night = nightNum;
	vigiSel.addEventListener('change', () => {
		nightData.vigiTarget = vigiSel.value;
		nightData.vigiShot = !!vigiSel.value;
		refreshConstraints();
	});
	vigiRow.appendChild(vigiSel);

	const vigiSpent = document.createElement('span');
	vigiSpent.className = 'vigi-spent hidden';
	vigiSpent.id = `vigi-spent-${nightNum}`;
	vigiSpent.textContent = 'Shot already used';
	vigiRow.appendChild(vigiSpent);

	vigiWrapper.appendChild(vigiRow);

	section.appendChild(vigiWrapper);

	// RNGs (predetermined from formals)
	const rngsCount = currentFormals && currentFormals[nightNum]
		? currentFormals[nightNum].count
		: 0;
	nightData.rngs = rngsCount;

	const rngsLabel = document.createElement('label');
	rngsLabel.className = 'night-label';
	rngsLabel.textContent = 'RNGs';
	section.appendChild(rngsLabel);

	const rngsValue = document.createElement('span');
	rngsValue.className = 'night-rngs';
	rngsValue.textContent = rngsCount;
	section.appendChild(rngsValue);

	// Discord output block
	const outputBlock = document.createElement('div');
	outputBlock.className = 'discord-block';

	const outputHeader = document.createElement('div');
	outputHeader.className = 'discord-header';

	const outputTitle = document.createElement('span');
	outputTitle.textContent = `Night ${nightNum} Output`;
	outputHeader.appendChild(outputTitle);

	const copyBtn = document.createElement('button');
	copyBtn.className = 'btn-copy';
	copyBtn.dataset.target = `night-output-${nightNum}`;
	copyBtn.textContent = 'Copy';
	outputHeader.appendChild(copyBtn);

	outputBlock.appendChild(outputHeader);

	const outputPre = document.createElement('pre');
	outputPre.className = 'discord-pre';
	outputPre.id = `night-output-${nightNum}`;
	outputBlock.appendChild(outputPre);

	section.appendChild(outputBlock);

	$('#nights-container').appendChild(section);
	refreshConstraints();
}

function continueToRecord() {
	renderEditableAssignments();
	if (currentFormals) {
		renderFormals(currentFormals, $('#locked-formals'));
		$('#locked-formals').previousElementSibling.classList.remove('hidden');
		$('#locked-formals').classList.remove('hidden');
	} else {
		$('#locked-formals').previousElementSibling.classList.add('hidden');
		$('#locked-formals').classList.add('hidden');
	}
	rebuildNight0Checks();

	// Auto-check N0 mafia kill targets
	if (nightActions.length > 0) {
		const n0Kills = [...new Set(nightActions[0].mafKills.filter(Boolean))];
		$$('#night0-checks input[type="checkbox"]').forEach((cb) => {
			cb.checked = n0Kills.includes(cb.value);
		});
	}

	$$('input[name="winner"]').forEach((r) => (r.checked = false));
	const winResult = checkWinCondition();
	if (winResult) {
		const radio = $(`input[name="winner"][value="${winResult.winner}"]`);
		if (radio) radio.checked = true;
	}
	$('#btn-submit').disabled = !winResult;
	updateRatedPreview();

	showPanel('panel-record');
	saveState();
}

// --- State persistence ---

function saveState() {
	const state = {
		currentAssignments, currentFormals, nightActions,
		dayVotes, vigiHasShot, rollCount, gameMode,
		activePanel: $('.panel:not(.hidden)')?.id,
	};
	const n0 = [...$$('#night0-checks input:checked')].map((cb) => cb.value);
	if (n0.length) state.n0Checks = n0;
	const winRadio = $('input[name="winner"]:checked');
	if (winRadio) state.winner = winRadio.value;

	if (gameMode === 'manual') {
		state.manualRoleMap = [...manualRoleMap];
		state.manualSkipMatch = [...manualSkipMatch];
		state.manualNames = manualNames;
	} else if (gameMode === 'retroactive') {
		state.retroRoleMap = [...retroRoleMap];
		state.retroSkipMatch = [...retroSkipMatch];
		state.retroNames = retroNames;
		const retroWinner = document.querySelector('input[name="retro-winner"]:checked');
		if (retroWinner) state.retroWinner = retroWinner.value;
		state.retroN0Checks = [...$$('#retro-n0-checks input:checked')].map((cb) => cb.value);
	}

	localStorage.setItem('mafiaGameState', JSON.stringify(state));
}

function clearSavedState() {
	localStorage.removeItem('mafiaGameState');
}

function restoreSelectValues(savedNights, savedDayVotes) {
	for (const nd of savedNights) {
		const n = nd.night;
		const mafSel1 = $(`.maf-select[data-night="${n}"][data-kill="0"]`);
		const mafSel2 = $(`.maf-select[data-night="${n}"][data-kill="1"]`);
		const copSel = $(`.cop-select[data-night="${n}"]`);
		const medicSel = $(`.medic-select[data-night="${n}"]`);
		const vigiSel = $(`.vigi-select[data-night="${n}"]`);
		if (mafSel1) mafSel1.value = nd.mafKills[0];
		if (mafSel2) mafSel2.value = nd.mafKills[1];
		if (copSel) copSel.value = nd.copCheck;
		if (medicSel) medicSel.value = nd.medicSave;
		if (vigiSel) vigiSel.value = nd.vigiTarget;
	}
	for (const [day, name] of Object.entries(savedDayVotes)) {
		const sel = $(`.day-vote-select[data-day="${day}"]`);
		if (sel) sel.value = name;
	}
}

function rebuildGamePanel(savedNights, savedDayVotes) {
	$('#role-reveal-pre').textContent = generateRoleReveal();
	$('#nights-container').innerHTML = '';
	nightActions = [];
	dayVotes = {};

	for (const nd of savedNights) {
		addNightSection(nd.night);
	}

	// Overwrite fresh nightActions with saved data
	for (let i = 0; i < savedNights.length; i++) {
		Object.assign(nightActions[i], savedNights[i]);
	}
	Object.assign(dayVotes, savedDayVotes);

	restoreSelectValues(savedNights, savedDayVotes);
	refreshConstraints();
	updateNightButtons();
}

async function restoreState() {
	const raw = localStorage.getItem('mafiaGameState');
	if (!raw) return false;

	try {
		const state = JSON.parse(raw);
		gameMode = state.gameMode || 'randomize';

		// Restore manual/retro state on randomize panel even without assignments
		if (state.activePanel === 'panel-randomize' && gameMode === 'manual' && state.manualNames) {
			manualNames = state.manualNames;
			manualRoleMap = new Map(state.manualRoleMap || []);
			manualSkipMatch = new Set(state.manualSkipMatch || []);
			$('#names-input').value = manualNames.join('\n');
			countNames();
			$('#assignments-display').classList.add('hidden');
			$('#retro-form').classList.add('hidden');
			$('#manual-setup').classList.remove('hidden');
			renderManualPlayerList(manualNames, 'manual-player-list', manualRoleMap, () => {
				$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
				$('#btn-manual-accept').disabled = !isRoleSelectionComplete(manualRoleMap);
				saveState();
			}, manualSkipMatch);
			$('#mafia-counter').textContent = roleCounterText(manualRoleMap);
			$('#btn-manual-accept').disabled = !isRoleSelectionComplete(manualRoleMap);
			showPanel('panel-randomize');
			return true;
		}

		if (state.activePanel === 'panel-randomize' && gameMode === 'retroactive' && state.retroNames) {
			retroNames = state.retroNames;
			retroRoleMap = new Map(state.retroRoleMap || []);
			retroSkipMatch = new Set(state.retroSkipMatch || []);
			$('#names-input').value = retroNames.join('\n');
			countNames();
			$('#assignments-display').classList.add('hidden');
			$('#manual-setup').classList.add('hidden');
			$('#retro-form').classList.remove('hidden');
			renderManualPlayerList(retroNames, 'retro-player-list', retroRoleMap, () => {
				updateRetroForm();
				saveState();
			}, retroSkipMatch);
			buildRetroN0Checks();
			if (state.retroN0Checks) {
				$$('#retro-n0-checks input[type="checkbox"]').forEach((cb) => {
					cb.checked = state.retroN0Checks.includes(cb.value);
				});
			}
			if (state.retroWinner) {
				const radio = $(`input[name="retro-winner"][value="${state.retroWinner}"]`);
				if (radio) radio.checked = true;
			}
			updateRetroForm();
			showPanel('panel-randomize');
			return true;
		}

		if (!state.currentAssignments) return false;

		currentAssignments = state.currentAssignments;
		currentFormals = state.currentFormals;
		vigiHasShot = state.vigiHasShot || false;
		rollCount = state.rollCount || 0;

		const savedNights = state.nightActions || [];
		const savedDayVotes = state.dayVotes || {};
		const panel = state.activePanel;

		if (panel === 'panel-randomize') {
			renderEditableAssignments($('#assignments-list'));
			if (currentFormals) renderFormals(currentFormals, $('#formals-schedule'));
			$('#roll-count').textContent = rollCount;
			$('#assignments-display').classList.remove('hidden');
			showPanel('panel-randomize');
		} else if (panel === 'panel-game') {
			rebuildGamePanel(savedNights, savedDayVotes);
			showPanel('panel-game');
		} else if (panel === 'panel-record') {
			rebuildGamePanel(savedNights, savedDayVotes);
			continueToRecord();
			// Restore N0 checkboxes
			if (state.n0Checks) {
				$$('#night0-checks input[type="checkbox"]').forEach((cb) => {
					cb.checked = state.n0Checks.includes(cb.value);
				});
			}
			// Restore winner radio
			if (state.winner) {
				const radio = $(`input[name="winner"][value="${state.winner}"]`);
				if (radio) radio.checked = true;
			}
			updateRatedPreview();
		}

		return true;
	} catch (e) {
		console.warn('Failed to restore state:', e);
		clearSavedState();
		return false;
	}
}

// --- Event listeners ---

document.addEventListener('DOMContentLoaded', () => {
	$('#names-input').addEventListener('input', countNames);
	$('#btn-randomize').addEventListener('click', doRandomize);
	$('#btn-reroll').addEventListener('click', doRandomize);
	$('#btn-accept').addEventListener('click', acceptAssignments);
	$('#btn-dice').addEventListener('click', async () => {
		const max = parseInt($('#dice-max').value) || 20;
		$('#btn-dice').disabled = true;
		try {
			const res = await fetch('https://api.random.org/json-rpc/4/invoke', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'generateIntegers',
					params: { apiKey: RANDOM_ORG_API_KEY, n: 1, min: 1, max, replacement: true },
					id: 1,
				}),
			});
			const data = await res.json();
			if (data.error) throw new Error(data.error.message);
			$('#dice-result').textContent = data.result.random.data[0];
		} catch (e) {
			$('#dice-result').textContent = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 * max) + 1;
		}
		$('#btn-dice').disabled = false;
	});
	$('#btn-back').addEventListener('click', () => showPanel('panel-game'));
	$('#btn-submit').addEventListener('click', submitResults);
	$('#btn-new-game').addEventListener('click', newGame);
	$('#btn-new-game-2').addEventListener('click', async () => {
		if (await confirmAction('Discard current game and start fresh?')) newGame();
	});
	$('#btn-new-game-3').addEventListener('click', async () => {
		if (await confirmAction('Discard current game and start fresh?')) newGame();
	});
	$('#btn-continue-record').addEventListener('click', continueToRecord);
	$('.container').addEventListener('click', handleCopyClick);
	$('#btn-undo-last')?.addEventListener('click', undoLastGame);

	$$('input[name="winner"]').forEach((r) => {
		r.addEventListener('change', () => {
			updateRatedPreview();
			saveState();
		});
	});

	// Manual Setup
	$('#btn-manual').addEventListener('click', doManualSetup);
	$('#btn-manual-cancel').addEventListener('click', () => {
		$('#manual-setup').classList.add('hidden');
		gameMode = 'randomize';
		manualRoleMap = new Map();
		saveState();
	});
	$('#btn-manual-accept').addEventListener('click', acceptManualSetup);

	// Retroactive Entry
	$('#btn-retro').addEventListener('click', doRetroEntry);
	$('#btn-retro-cancel').addEventListener('click', () => {
		$('#retro-form').classList.add('hidden');
		gameMode = 'randomize';
		retroRoleMap = new Map();
		retroNames = [];
		saveState();
	});
	$('#btn-retro-submit').addEventListener('click', submitRetroGame);
	$$('input[name="retro-winner"]').forEach((r) => {
		r.addEventListener('change', () => {
			updateRetroForm();
			saveState();
		});
	});

	loadPlayerNames().then(async () => {
		const restored = await restoreState();
		if (!restored) loadLastGame();
	});
});
