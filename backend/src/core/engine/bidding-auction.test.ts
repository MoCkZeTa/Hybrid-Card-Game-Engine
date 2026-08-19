/**
 * Targeted coverage for the 29-style multi-round bidding auction
 * (`bidding.style: "auction"`): the floor is 16, passing is permanent, a
 * still-active seat keeps getting turns to raise, a seat that opened earlier
 * may *hold* the current number instead of outbidding it
 * (`holdBidBySeniority`) while a junior seat may not, the auction ends the
 * instant only one un-passed seat remains, and `dealerMustBid` forces a bid
 * rather than a pass when nobody has bid yet and everyone else is out.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../plugin/plugin-manager.js';
import { InMemoryPluginRepository } from '../plugin/plugin-repository.js';
import { createRng } from './deck.js';
import { createMatch } from './state.js';
import { generateLegalMoves } from './legal-moves.js';
import { applyMove } from './apply-move.js';

const gamesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'games');

async function loadRules() {
  const plugins = await PluginManager.loadAll(gamesRoot, new InMemoryPluginRepository());
  return plugins.get('29').rules;
}

function newMatch(rules: Awaited<ReturnType<typeof loadRules>>, matchId: string, seed: number) {
  return createMatch({
    rules,
    gameId: '29',
    matchId,
    playerCount: 4,
    dealerSeat: 0,
    playerNames: ['A', 'B', 'C', 'D'],
    aiSeats: new Set(),
    rng: createRng(seed),
  });
}

describe('29 auction-style bidding', () => {
  it('opens at 16 and never offers a lower bid', async () => {
    const rules = await loadRules();
    const state = newMatch(rules, 'auction-floor', 7);

    expect(rules.bidding?.minBid).toBe(16);
    const moves = generateLegalMoves(rules, state);
    const values = moves
      .filter((m) => m.actions[0]!.type === 'PLACE_BID')
      .map((m) => (m.actions[0] as { value: number }).value);
    expect(Math.min(...values)).toBe(16);
    expect(Math.max(...values)).toBe(28);
  });

  it('lets a still-active seat raise on a later turn after being outbid, while a passed seat never acts again', async () => {
    const rules = await loadRules();
    let state = newMatch(rules, 'auction-1', 1);
    expect(state.phase).toBe('BIDDING');
    expect(state.turnSeat).toBe(1); // left of dealer speaks first

    // Seat 1 bids the floor (16) and so becomes the most senior bidder.
    state = applyMove(rules, state, 'bid-16');
    expect(state.players[1]!.bid).toBe(16);
    expect(state.players[1]!.bidOrder).toBe(0);
    expect(state.turnSeat).toBe(2);

    // Seat 2 passes — permanently out.
    state = applyMove(rules, state, 'pass');
    expect(state.players[2]!.bid).toBe(-1);
    expect(state.turnSeat).toBe(3); // skips straight past the passed seat 2

    // Seat 3 must go higher than 16 to take the contract.
    const seat3Moves = generateLegalMoves(rules, state);
    expect(seat3Moves.some((m) => m.id === 'bid-16')).toBe(false);
    state = applyMove(rules, state, 'bid-17');
    expect(state.players[3]!.bid).toBe(17);
    expect(state.players[3]!.bidOrder).toBe(1);
    expect(state.turnSeat).toBe(0);

    // Dealer (seat 0) passes.
    state = applyMove(rules, state, 'pass');
    expect(state.turnSeat).toBe(1); // wraps back to seat 1, skipping passed 0 and 2

    // Seat 1 is still active and gets to raise again over seat 3's 17.
    expect(state.phase).toBe('BIDDING');
    expect(generateLegalMoves(rules, state).some((m) => m.id === 'bid-18')).toBe(true);
    state = applyMove(rules, state, 'bid-18');
    expect(state.players[1]!.bid).toBe(18);
    expect(state.players[1]!.bidOrder).toBe(0); // seniority set at the opening bid, unchanged by the raise

    // Seat 3 (the only other active bidder) passes — auction ends, only seat 1 remains.
    state = applyMove(rules, state, 'pass');
    expect(state.phase).toBe('TRUMP_SELECTION');
    expect(state.declarerSeat).toBe(1);
    expect(state.turnSeat).toBe(1);
  });

  it('lets the earlier bidder hold the challenger\'s number, after which the challenger must go higher', async () => {
    const rules = await loadRules();
    let state = newMatch(rules, 'auction-hold', 3);

    state = applyMove(rules, state, 'bid-16'); // seat 1 opens (senior)
    state = applyMove(rules, state, 'pass'); // seat 2 out
    state = applyMove(rules, state, 'bid-19'); // seat 3 challenges
    state = applyMove(rules, state, 'pass'); // dealer out
    expect(state.turnSeat).toBe(1);

    // Seat 1 bid first, so it may match 19 rather than being forced to 20.
    const seat1Moves = generateLegalMoves(rules, state);
    const hold = seat1Moves.find((m) => m.id === 'bid-19');
    expect(hold?.label).toBe('Hold at 19');
    state = applyMove(rules, state, 'bid-19');
    expect(state.players[1]!.bid).toBe(19);
    expect(state.phase).toBe('BIDDING'); // contract is seat 1's now; seat 3 still gets a turn

    // Seat 3 is junior on the same number, so 19 is no longer available to it.
    expect(state.turnSeat).toBe(3);
    const seat3Moves = generateLegalMoves(rules, state);
    expect(seat3Moves.some((m) => m.id === 'bid-19')).toBe(false);
    expect(seat3Moves.some((m) => m.id === 'bid-20')).toBe(true);

    // Seat 3 gives up: the held bid wins the auction for the senior bidder.
    state = applyMove(rules, state, 'pass');
    expect(state.phase).toBe('TRUMP_SELECTION');
    expect(state.declarerSeat).toBe(1);
    expect(state.players[1]!.bid).toBe(19);
  });

  it('forces a bid of the 16 minimum instead of offering a pass when every other seat has passed and this seat has not bid yet', async () => {
    const rules = await loadRules();
    let state = newMatch(rules, 'auction-2', 2);

    // Seats 1, 2, 3 all pass before the dealer (seat 0) ever acts.
    for (const expectedSeat of [1, 2, 3]) {
      expect(state.turnSeat).toBe(expectedSeat);
      state = applyMove(rules, state, 'pass');
    }

    // Dealer is the sole un-passed seat with no bid yet: no pass is offered.
    expect(state.turnSeat).toBe(0);
    const dealerMoves = generateLegalMoves(rules, state);
    expect(dealerMoves.some((m) => m.id === 'pass')).toBe(false);
    expect(dealerMoves.every((m) => m.actions[0]!.type === 'PLACE_BID')).toBe(true);

    state = applyMove(rules, state, 'bid-16');
    expect(state.players[0]!.bid).toBe(16);
    expect(state.phase).toBe('TRUMP_SELECTION');
    expect(state.declarerSeat).toBe(0);
  });
});
