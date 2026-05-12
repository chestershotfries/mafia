/* Ego Mafia — match history page */

const $ = (sel) => document.querySelector(sel);

function showToast(msg) {
	const toast = $('#toast');
	toast.textContent = msg;
	toast.classList.remove('hidden');
	clearTimeout(toast._timer);
	toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function loadData() {
	try {
		const resp = await fetch('./data.json', { cache: 'no-cache' });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const data = await resp.json();
		renderSummary(data.game_summary);
		renderGames(data.games);
	} catch (e) {
		showToast('Failed to load data: ' + e.message);
	}
}

function renderSummary(s) {
	$('#stat-total-games').textContent = s.total_games;
	$('#stat-mafia-pct').textContent = s.mafia_win_pct + '%';
	$('#stat-town-pct').textContent = s.town_win_pct + '%';
}

function renderGames(games) {
	const container = $('#games-list');
	container.innerHTML = '';

	if (!games.length) {
		container.innerHTML = '<p style="color: var(--text-muted)">No games yet.</p>';
		return;
	}

	for (const g of games) {
		const card = document.createElement('div');
		card.className = 'game-card';

		const winnerClass = g.winner.toLowerCase() === 'mafia' ? 'mafia' : 'town';
		const mafiaPills = g.mafia
			.map((n) => `<span class="player-pill mafia">${escapeHtml(n)}</span>`)
			.join(' ');
		const townPills = g.town
			.map((t) => {
				const roleTag = t.role !== 'Town'
					? `<span class="role">${escapeHtml(t.role)}</span>`
					: '';
				return `<span class="player-pill town">${escapeHtml(t.name)}${roleTag}</span>`;
			})
			.join(' ');

		let extra = '';
		if (g.n0.length) {
			const pills = g.n0.map((n) => `<span class="player-pill">${escapeHtml(n)}</span>`).join(' ');
			extra += `<div class="game-card-row"><span class="game-card-label">N0</span>${pills}</div>`;
		}
		if (g.ghosts.length) {
			const pills = g.ghosts
				.map((n) => `<span class="player-pill">${escapeHtml(n)}</span>`)
				.join(' ');
			extra += `<div class="game-card-row"><span class="game-card-label">Ghosts</span>${pills}</div>`;
		}

		card.innerHTML = `
			<div class="game-card-header">
				<span class="game-card-id">Game ${g.game_id}</span>
				<span class="game-card-winner ${winnerClass}">${escapeHtml(g.winner)} Win</span>
			</div>
			<div class="game-card-row"><span class="game-card-label">Mafia</span>${mafiaPills}</div>
			<div class="game-card-row"><span class="game-card-label">Town</span>${townPills}</div>
			${extra}
		`;
		container.appendChild(card);
	}
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

document.addEventListener('DOMContentLoaded', loadData);
