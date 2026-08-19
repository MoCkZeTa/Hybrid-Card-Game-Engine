# Mendicot — Strategic Guide

You are playing Mendicot, a 4-player partnership trick-taking game on a full
52-card deck. You and the player sitting across from you are a team; the two
players either side of you are opponents. Everyone is dealt 13 cards and 13
tricks are played.

**Only the four Tens score.** Winning a trick is worthless in itself — a
trick matters exactly as much as whether a Ten fell into it. Your side scores
one point per Ten it captures, and the match runs until a side reaches the
target or the hand limit runs out.

This plugin uses the fixed-trump variant: the dealer's partner names trump
after seeing their hand, before the first lead. Trump is public from that
moment on.

## Core strategic principles

- **Count the Tens, not the tricks.** A hand where you take nine tricks and
  no Tens is a loss. Before every play, ask which Tens are still out and
  whether this trick can plausibly contain one.
- **Protect your own Tens.** A bare Ten is a liability — it will be captured
  the moment its suit is led by someone stronger. Lead the suit yourself
  only when you can win the trick, or hold the Ten until you can discard it
  onto a trick your partner is already winning.
- **Feed Tens to your partner.** When your partner is clearly winning a
  trick (they played a high trump, or the highest card of the led suit and
  nothing can beat it), that is the moment to drop a Ten. This is the single
  biggest source of points in the game.
- **Trump aggressively over a Ten.** If a Ten has been played and you are
  void in the led suit, spending a trump is almost always correct — one
  trump for one point is a good trade in a game with only four points on the
  table.

## Reading the table

- **Track voids.** Once an opponent discards off-suit they will trump that
  suit whenever it is led again. Route Tens away from a suit an opponent is
  void in unless you can overtrump.
- **Watch who chose trump.** The chooser named the suit from their own hand,
  so they are long and strong in it. Expect them to draw trump early; plan
  to keep enough trump to still contest the last few tricks.
- **Count trump.** With 13 tricks there is time to draw trump and then cash
  a long side suit. If you hold the last trump, every Ten still in a suit you
  control is effectively yours.

## Decision heuristics

- **Leading:** early on, lead a suit where you hold the Ace and not the Ten —
  you win the trick safely and force out high cards without risking a point.
  Avoid leading a suit where you hold a bare Ten.
- **Following when you can:** play low unless the trick already contains a
  Ten or you can win it outright. Wasting high cards on empty tricks leaves
  you unable to contest the ones that matter.
- **Following when you cannot:** if the trick holds a Ten, trump it if you
  can. If it does not, discard your most useless card — ideally shortening a
  suit so you can trump it later.
- **Endgame:** by the last few tricks you should know exactly which Tens
  remain and who can still trump. Play the endgame to guarantee the
  outstanding Tens rather than to maximise tricks.
