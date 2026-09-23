# suggest_4 — how to make it more fun

Answers `prompt_4.md` item 3.  Written from the drives this iteration made
rather than from the code: the two-day film (`/media/DRIVE2/country-road/
two-days`, its hourly stills and its log), about 90 minutes of scripted
play across two seeds (`tools/play/autoplay.mjs`, which uses every key a
player has), and the probes' own frames.

## What the drive is like now

**It is beautiful, and it is the same minute over and over.**  The
contact sheet of the film is the clearest evidence: hour after hour, the
car centred, the road running into the middle of the frame, green hills,
conifers, clouds.  In the first fourteen game-hours there is one lake,
and nothing else that marks a *place* — no village, no farmhouse, no
bridge, no sign, no other vehicle, no animal.  Forty kilometres in, a
player has no way to say where they are or where they have been.

**There is nothing to do.**  The log says the autopilot spends 72 % of
the drive between 18 and 21 m/s and never strays two metres from the
midline, which is exactly right for a relaxing drive, and it means the
player's hands have no job.  Manual driving is the only activity, and it
is the same activity for as long as you do it.

**Night is ten minutes of black.**  20:00 to 06:00 is 42 % of every
game-day, and from about 20:00 the frame is a headlight cone on darkness.
Every night still in the film is nearly the same picture.  At 24 minutes
a day, a player who sits down in the evening spends their first ten
minutes seeing almost nothing.

**The weather is the best thing in it.**  Ten changes in 36 game-hours,
heavy rain a quarter of the time, and the late afternoon of the first day
is dramatic: a banked, bruised sky over wet road, then a pink break at
dusk.  Those are the stills worth keeping.

**The year is invisible inside a sitting.**  A season is three game-days,
72 real minutes, so the thing no other driving game has — four seasons in
one drive — is something most players will never see change.

**A tap of the wheel is a swerve.**  Under full autodrive, holding A or D
for 0.6 to 1.2 s at 20 m/s put the car 13 to 45 m into the field; the
autopilot brought it back every time, in 5 to 12 s.  The steering does
close its lock with speed, so this is partly honest, but "take the wheel
for a moment" does not feel like a moment.

**Photo mode is half there.**  `core/input.js` binds `P` to a `photo`
command, and nothing handles it: the key does nothing.

## What to do about it, ranked

Each one is costed against the spec: first load within 2–3 s, and
playable on entry-level phones.

### 1. Places

Give the road somewhere to go through.  A seeded landmark every 2–4 km:
a farmhouse with a windbreak, a woolshed, a silo, a windmill and tank, a
one-lane bridge over a creek, a lookout, a war memorial at a crossroads,
and every 15–25 km a small town — a pub, a servo, a hall, a dozen houses.
Name the towns from the seed and put up **signposts with distances**
("Wattle Creek 12").  That one detail turns an endless road into a
journey: the player now has a next thing, and the drive has chapters.

This is the highest-value item, because every other suggestion gets
better with places in the world.  Cost: low-poly instanced props like
the scatter's trees, streamed after the first frame the way chunks are,
so zero on first load.  The furniture system already places things along
the road by arc length.

### 2. Something to collect

A soft goal that suits a relaxing drive: **a postcard album**.  Finish
the photo mode `P` is already bound for — hide the HUD, free the camera,
save the frame — and give it a list of moments to catch, drawn from
systems the game already has:

- a rainbow (`weather.rainbow()` exists)
- the full moon rising at sunset (the clock already makes that happen)
- lightning, snow on the road, fog in a valley
- a sunset over water, the first light after a rest
- each town's sign

Each one is a card in an album on the pause screen, per season.  No
timer, no failure: the reward is a reason to keep driving into weather
instead of resting through it.  Cost: UI plus a few checks on state that
already exists; a thumbnail per card in `localStorage`.

### 3. Make night worth seeing

A cel-shaded night should be blue, not black: a drawn background's
darks are coloured.  Lift moonlit ambient toward a readable blue-grey,
and let the ink follow (it already darkens at night — see `setNight`).
Then add the things that make a country road at night: reflector posts
catching the headlights, a farmhouse window in the distance, a town's
glow on the horizon, stars bright on a clear night, a kangaroo's eyes
at the verge.  Cost: mostly constants and a few emissive points, no
extra passes.  Payoff: 42 % of the game.

### 4. Seasons you can see in one sitting

Either shorten the season (one game-day each makes a year 96 minutes,
as discussed after the plan), or make seasons *places* as well as times:
snow on high ground in winter, blossom and green in spring valleys,
brown paddocks in late summer, a line of autumn colour along a river.
Either way, make the transition something you watch arrive: leaves
turning over a game-hour, the first frost on the verge at dawn.

### 5. Life on the road

A handful of oncoming cars, a tractor to overtake on a straight, a
cyclist, sheep and cattle in paddocks, cockatoos lifting off a dead tree,
kangaroos at dusk.  The prompt's own setting is the Australian east
coast, and none of this is in the world yet.  Traffic also gives manual
driving a job: an overtake is a decision.  Cost: instanced low-poly,
simple along-road agents on the spline, no physics needed for most.

### 6. Road you remember

The road is gentle everywhere, which is right on average and flat in
total.  Seed some set pieces: a switchback climb to a pass, a coast road
with the sea on one side (east coast!), a ford or a single-lane timber
bridge, a gravel detour, an avenue of trees.  Each of these is a thing a
player tells someone else about.

### 7. Hands on the wheel, gently

Under autodrive, make a short tap of A or D a **lane nudge**: a small
offset the autopilot holds and eases back from, rather than raw steering.
Keep raw steering for manual mode.  And add a drive-quality readout for
manual driving (smoothness, not speed) that fills the album too.

### 8. Sound

The engine is there, and so are birds.  A radio with a few seeded
stations — ambient, country, talkback murmur — or rain on the roof and
wipers would do a great deal for the mood.  Stream after first load.

### 9. A way to share

The pause screen now has the fork link.  Add "send a postcard": the
current frame, the seed and the clock as a URL.  A friend opens the same
road at the same hour.  Seeds and pinned time already exist
(`?seed`, `?t`, `?day`), so this is mostly UI.

## If there is time for only one

**Places, with signposts.**  It is the one change that makes each of the
others better and that answers the plainest thing the film shows: after
forty minutes, nothing has happened and there is nowhere you have been.
