/* Mafia Stats page — leaderboard, game summary, player detail */

const SCRIPT_URL = 'https://us-central1-mafia-tracker-310960.cloudfunctions.net/mafia-backend';

let statsData = null;
let currentSort = { key: 'rating', desc: true };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Toast ---

function showToast(msg) {
	const toast = $('#toast');
	toast.textContent = msg;
	toast.classList.remove('hidden', 'success');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
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

// --- Stats loading ---

async function loadStats() {
	try {
		statsData = await api('getStats');
		renderStatsSummary(statsData.game_summary);
		renderLeaderboard(statsData.players);
	} catch (e) {
		showToast('Failed to load stats: ' + e.message);
	}
}

function renderStatsSummary(summary) {
	$('#stat-total-games').textContent = summary.total_games;
	$('#stat-mafia-pct').textContent = summary.mafia_win_pct + '%';
	$('#stat-town-pct').textContent = summary.town_win_pct + '%';
}

// --- Leaderboard ---

function renderLeaderboard(players) {
	// Build rank map based on rating (always descending)
	const byRating = [...players].sort((a, b) => b.rating - a.rating);
	const rankMap = new Map();
	byRating.forEach((p, i) => rankMap.set(p.name, i + 1));

	const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
	const rankClass = (r) => {
		if (r === 1) return 'rank-gold';
		if (r === 2) return 'rank-silver';
		if (r === 3) return 'rank-bronze';
		if (r <= 15) return 'rank-top15';
		return '';
	};

	const sorted = [...players].sort((a, b) => {
		const aVal = a[currentSort.key];
		const bVal = b[currentSort.key];

		if (currentSort.key === 'name') {
			return currentSort.desc
				? bVal.localeCompare(aVal)
				: aVal.localeCompare(bVal);
		}

		return currentSort.desc ? bVal - aVal : aVal - bVal;
	});

	const tbody = $('#stats-tbody');
	tbody.innerHTML = '';

	for (const p of sorted) {
		const rank = rankMap.get(p.name);
		const tr = document.createElement('tr');
		tr.dataset.player = p.name;
		if (rank === 15) tr.classList.add('rank-divider');
		tr.innerHTML = `
			<td class="${rankClass(rank)}">${medals[rank] || rank}</td>
			<td>${p.name}</td>
			<td>${p.rating}</td>
			<td>${p.total_games}</td>
			<td>${p.total_win_pct}%</td>
			<td>${p.mafia_games}</td>
			<td>${p.mafia_win_pct}%</td>
			<td>${p.town_games}</td>
			<td>${p.town_win_pct}%</td>
		`;
		tr.addEventListener('click', () => loadPlayerDetail(p.name));
		tbody.appendChild(tr);
	}

	$$('#stats-table th').forEach((th) => {
		th.classList.remove('sort-active', 'sort-asc', 'sort-desc');
		if (th.dataset.sort === currentSort.key) {
			th.classList.add('sort-active');
			th.classList.add(currentSort.desc ? 'sort-desc' : 'sort-asc');
		}
	});
}

// --- Player detail ---

async function loadPlayerDetail(playerName) {
	const detailPanel = $('#player-detail');
	const tbody = $('#detail-tbody');
	const loading = $('#detail-loading');

	$$('#stats-tbody tr').forEach((tr) => {
		tr.classList.toggle('selected', tr.dataset.player === playerName);
	});

	$('#detail-player-name').textContent = playerName;
	detailPanel.classList.remove('hidden');
	tbody.innerHTML = '';
	loading.classList.remove('hidden');

	try {
		const data = await api('getPlayerHistory', { player_name: playerName });
		loading.classList.add('hidden');

		for (const g of data.games) {
			const tr = document.createElement('tr');
			const alignClass = g.alignment === 'Mafia' ? 'align-mafia' : 'align-town';
			const isExcluded = g.result === 'Ghost' || g.result === 'Night Zero';
			const ratingDisplay = g.old_rating !== undefined
				? `${g.old_rating} \u2192 ${g.new_rating}`
				: '-';
			const changeClass = g.rate_change >= 0 ? 'change-pos' : 'change-neg';
			const sign = g.rate_change >= 0 ? '+' : '';

			tr.innerHTML = `
				<td>#${g.game_id}</td>
				<td class="${alignClass}">${g.alignment}</td>
				<td>${g.result}</td>
				<td>${ratingDisplay}</td>
				<td class="${isExcluded ? '' : changeClass}">${isExcluded ? '-' : sign + g.rate_change}</td>
			`;
			if (isExcluded) tr.classList.add('excluded-row');
			tbody.appendChild(tr);
		}
	} catch (e) {
		loading.classList.add('hidden');
		showToast('Failed to load player history: ' + e.message);
	}
}

// --- Event listeners ---

document.addEventListener('DOMContentLoaded', () => {
	$$('#stats-table th[data-sort]').forEach((th) => {
		th.addEventListener('click', () => {
			const key = th.dataset.sort;
			if (currentSort.key === key) {
				currentSort.desc = !currentSort.desc;
			} else {
				currentSort.key = key;
				currentSort.desc = key !== 'name';
			}
			if (statsData) {
				renderLeaderboard(statsData.players);
			}
		});
	});

	$('#btn-close-detail').addEventListener('click', () => {
		$('#player-detail').classList.add('hidden');
		$$('#stats-tbody tr').forEach((tr) => tr.classList.remove('selected'));
	});

	loadStats();
});
