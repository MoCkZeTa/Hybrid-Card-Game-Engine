# Game plugin library

Ready-to-use `rules.json` + `strategy.md` pairs for trick-taking games the
engine can run today. Each folder is a complete plugin — the same two files a
game under `backend/src/games/` consists of, validated by the same
`validateRulesDsl`.

Nothing here is loaded automatically. `backend/src/games/` is the directory
the server scans at boot; this is a catalog you pull from.

## Installing one

Either copy the folder into the server's games directory:

```
cp -r game-plugins/hearts backend/src/games/hearts
```

...and restart the backend. Copied in this way the folder name becomes the
game's id, and it counts as a built-in: visible to everyone, and read-only.

Or import it at runtime without a restart — `POST /api/plugins` with the
parsed `rules.json` and the `strategy.md` text, which is what the Lobby's
import panel does. An imported plugin is stored in the database rather than on
disk, is private to whoever imported it, and gets an id the server assigns.

## Identity is not in the file

None of these `rules.json` files declare a `gameId`, and adding one makes the
plugin **fail validation**. The server assigns identity — folder name for a
copied-in game, a generated id for an imported one — so the same file can be
imported twice as two independent games, and no plugin can claim (or clobber)
another's name. `displayName` is what names the game for players.

## Editing one

Both files are meant to be edited. `rules.json` is the whole game — change
`scoring.targetScore` to shorten a match, change `trickRules` to play a house
variant, change `deck.rankOrder` to reorder card strength. The engine reads
all of it at load time and rejects anything that does not validate, so a typo
fails loudly rather than producing a subtly wrong game.

Editing a game you imported is `PUT /api/plugins/:gameId`, which keeps its id
so matches and rooms referencing it stay valid. The two shipped games (29 and
Callbreak) cannot be edited or deleted at all: to make your own version of
one, open its source, change it, and import it — you get a private copy and
the original is untouched.

`strategy.md` is injected verbatim into the AI's system prompt. It does not
affect what is legal — the engine decides that — only how well the AI plays.
If you change a rule in `rules.json`, change the matching advice here too, or
the AI will be reasoning about a game it is not playing.

## What's here

| Folder | Game | Notable mechanics it exercises |
| --- | --- | --- |
| `325/` | 3-2-5 (Teen Do Paanch) | 30-card deck via `excludedCards`, staged deal, `chooser` trump, per-seat fixed quotas, signed-difference scoring |
| `mendicot/` | Mendicot | Partnership, `threshold-win` on the four Tens |
| `court-piece/` | Court Piece (Rung) | `declared-by-lead` trump — the opening lead fixes the suit |
| `whist/` | Whist (No Trump) | `trump.mode: "none"`, capture scoring above a six-trick threshold |
| `hearts/` | Hearts | Penalty scoring, `lowerIsBetter`, locked lead suits, shooting the moon |
| `spades/` | Spades | `bid-multiplier` scoring, accumulating bags, nil bids |
| `oh-hell/` | Oh Hell | Per-hand deal schedule, `kitty-turnup` trump, exact bids, the hook rule |

29 and Callbreak ship with the server and are not duplicated here — see
`backend/src/games/29/` and `backend/src/games/callbreak/`.

Games that need engine work before they can be expressed at all are listed in
`../TODO.md`.

## Caveats

These are faithful to each game's core mechanics, but a few peripheral rules
are not modelled, because the engine has no primitive for them yet:

- **Hearts** is missing three rules. It has no card-passing phase (the
  pass-left/right/across rotation), so every hand plays as a "no-pass" hand;
  the first trick is not forced to be led by the Two of Clubs; and penalty
  cards are not barred from the first trick ("no blood on the first trick").
  The hearts-must-be-broken rule *is* implemented. The passing phase needs
  micro-phases; the two first-trick rules need a first-trick restriction
  primitive that does not exist yet.
- **3-2-5** has no between-hands card-pulling exchange. Needs micro-phase
  support.
- **Mendicot** uses the fixed-trump variant, where the dealer's partner names
  trump before play, rather than the variant where trump is discovered when a
  player first cannot follow suit.
- **Court Piece** scores one point for taking seven of the thirteen tricks,
  rather than tracking "hands" and "courts" across a session.
- **Mendicot** needs three of the four Tens to score the hand. A 2-2 Ten split
  scores nobody; the real tiebreak (most tricks takes it) is not modelled.

`../TODO.md` covers the missing primitives in detail.
