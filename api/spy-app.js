// spy-app.js
async function compareManagers(myId, rivalId, gw) {
    // 1. Fetch both squads
    const [myRes, rivalRes] = await Promise.all([
        fetch(`/api/fpl?managerId=${myId}&gameweek=${gw}`).then(r => r.json()),
        fetch(`/api/fpl?managerId=${rivalId}&gameweek=${gw}`).then(r => r.json())
    ]);

    // 2. Extract player IDs
    const myPicks = myRes.picks.map(p => p.element);
    const rivalPicks = rivalRes.picks.map(p => p.element);

    // 3. Find Differentials (Players they have that you don't)
    const differentials = rivalPicks.filter(id => !myPicks.includes(id));

    // 4. Check Captains
    const myCap = myRes.picks.find(p => p.is_captain).element;
    const rivalCap = rivalRes.picks.find(p => p.is_captain).element;

    // 5. Display Results
    const container = document.getElementById('comparison-results');
    container.innerHTML = `
        <p><strong>Captain Alert:</strong> Rival captain is ${rivalCap === myCap ? "the same as yours!" : "DIFFERENT!"}</p>
        <p><strong>Differentials:</strong> They have ${differentials.length} players you don't have.</p>
    `;
}

// Run this when the page loads
compareManagers('YOUR_ID', 'RIVAL_ID', 1); // Replace with actual IDs