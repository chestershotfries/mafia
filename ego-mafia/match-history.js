/* Ego Mafia Match History — last-game-style table per game.
 * Reads window.SCRIPT_URL when set (Cloud Function), else ./data.json. */

const $ = (sel) => document.querySelector(sel);

const MEDALS = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };

function rankClass(r) {
	if (r === 1) return 'rank-gold';
	if (r === 2) return 'rank-silver';
	if (r === 3) return 'rank-bronze';
	if (typeof r === 'number' && r <= 15) return 'rank-top15';
	return '';
}

function roleAlignmentClass(role) {
	if (role === 'Mafia') return 'align-mafia';
	if (role === 'Cop') return 'role-cop';
	if (role === 'Medic') return 'role-medic';
	if (role === 'Vigilante') return 'role-vig';
	return 'align-town';
}

function showToast(msg) {
	const toast = $('#toast');
	if (!toast) return;
	toast.textContent = msg;
	toast.classList.remove('hidden');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function api(action, data = {}) {
	const resp = await fetch(window.SCRIPT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, ...data }),
	});
	const result = await resp.json();
	if (result.error) throw new Error(result.error);
	return result;
}

async function load() {
	try {
		let players, games;
		if (window.SCRIPT_URL) {
			const [stats, mh] = await Promise.all([
				api('getStats'),
				api('getMatchHistory'),
			]);
			players = stats.players;
			games = mh.games;
		} else {
			const resp = await fetch('./data.json', { cache: 'no-cache' });
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			players = data.players;
			games = data.games;
		}
		const rankMap = new Map();
		const byRating = [...(players || [])].sort((a, b) => b.rating - a.rating);
		byRating.forEach((p, i) => rankMap.set(p.name, i + 1));
		render(games || [], rankMap);
	} catch (e) {
		showToast('Failed to load match history: ' + e.message);
	}
}

function render(games, rankMap) {
	const container = $('#games-list');
	container.innerHTML = '';

	if (!games.length) {
		container.innerHTML = '<p style="color: var(--text-muted)">No games yet.</p>';
		return;
	}

	for (const g of games) {
		container.appendChild(renderGame(g, rankMap));
	}
}

function renderGame(g, rankMap) {
	const card = document.createElement('section');
	card.className = 'last-game match-history-game';

	const winnerLabel = g.winner ? `${escapeHtml(g.winner)} Win` : '—';
	const winnerCls = (g.winner || '').toLowerCase() === 'mafia' ? 'align-mafia' : 'align-town';

	let rows = '';
	for (const p of g.players || []) {
		const alignCls = roleAlignmentClass(p.role);
		const isExcluded = p.result === 'Ghost' || p.result === 'Night Zero';
		if (isExcluded) {
			rows += `<tr class="excluded-row">
				<td>-</td>
				<td>${escapeHtml(p.player)}</td>
				<td class="${alignCls}">${escapeHtml(p.role)}</td>
				<td>${escapeHtml(p.result)}</td>
				<td>-</td>
				<td>0</td>
			</tr>`;
		} else {
			const changeCls = p.rate_change >= 0 ? 'change-pos' : 'change-neg';
			const resultCls = p.result === 'Win' ? 'change-pos' : 'change-neg';
			const sign = p.rate_change >= 0 ? '+' : '';
			const rank = rankMap.get(p.player) ?? '-';
			const rc = typeof rank === 'number' ? rankClass(rank) : '';
			rows += `<tr>
				<td class="${rc}">${MEDALS[rank] || rank}</td>
				<td>${escapeHtml(p.player)}</td>
				<td class="${alignCls}">${escapeHtml(p.role)}</td>
				<td class="${resultCls}">${escapeHtml(p.result)}</td>
				<td>${p.new_rating ?? '-'}</td>
				<td class="${changeCls}">${sign}${p.rate_change}</td>
			</tr>`;
		}
	}

	card.innerHTML = `
		<div class="match-history-header">
			<strong>Game #${g.game_id}</strong>
			<span class="${winnerCls}">${winnerLabel}</span>
		</div>
		<table>
			<thead>
				<tr>
					<th>#</th><th>Player</th><th>Role</th><th>Result</th><th>Ego</th><th>Change</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>
	`;
	return card;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[c]));
}

document.addEventListener('DOMContentLoaded', load);
