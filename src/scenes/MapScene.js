import Phaser from 'phaser';
import { Worker } from '../entities/Worker.js';
import { Marine } from '../entities/Marine.js';
import { Mech } from '../entities/Mech.js';
import { Zapper } from '../entities/Zapper.js';
import { Tank } from '../entities/Tank.js';
import { Reaper } from '../entities/Reaper.js';
import { Biter } from '../entities/Biter.js';
import { Chojin } from '../entities/Chojin.js';
import { HeavyChojin } from '../entities/HeavyChojin.js';
import { CommandCenter } from '../entities/CommandCenter.js';
import { Barracks } from '../entities/Barracks.js';
import { Factory } from '../entities/Factory.js';
import { ConstructionSite } from '../entities/ConstructionSite.js';
import { TILE, EXTRUDE, UNIT_CARRY_CAPACITY } from '../constants.js';
import { flowLibrary } from '../flow/library.js';
import { openAssignOverlay } from '../flow/assign.js';
import { registerPositionPicker } from '../flow/positionPicker.js';
import { startRun, tickRun } from '../flow/runtime.js';
import { getNodeKind } from '../flow/nodeKinds.js';
import { MovementSystem } from '../movement.js';
import { getResource, RESOURCES } from '../resources.js';
import { DECORATIONS } from '../decorations.js';
import { FACTION, getUnitType, getBuildingType } from '../units.js';
import { applyDamage } from '../entities/runner.js';
import { CombatSystem } from '../combat.js';
import { AttackEffects } from '../effects.js';
import { SCENARIO, enemyFlowModel, critterFlowModel } from '../scenario.js';
import '../flow/editor.css'; // shared overlay chrome — styles the Start/Pause button
const MAP_W = 120;
const MAP_H = 90;

// Unit type id → class, for spawning produced/Enemy Units by type (docs/adr/0013, 0014).
const UNIT_CLASS = { worker: Worker, marine: Marine, zapper: Zapper, reaper: Reaper, tank: Tank, mech: Mech, chojin: Chojin, 'heavy-chojin': HeavyChojin };
// Building type key → entity class, for raising a finished Building from a Construction Site (docs/adr/0018).
const BUILDING_CLASS = { command_center: CommandCenter, barracks: Barracks, factory: Factory };

// Tiles kept clear of alloys/decorations around the command center, beyond its footprint,
// so the start area stays open (docs/adr/0009).
const START_CLEARANCE = 3;

// How close (in Tiles, to the footprint) a Worker must be to deliver Cargo. Forgiving, since a
// large blocking Building makes Units settle a Tile or two short of touching it (docs/adr/0008).
const DELIVER_RANGE = 2;

// How far (in Tiles) from where a Worker was rallied Gather looks for a Deposit to claim. Covers a
// typical 3–6 Deposit cluster plus arrival slop; beyond it the Worker waits in place rather than
// wandering to a far field, treating the rally as a "gather here" instruction (docs/adr/0017).
const CLAIM_RADIUS = 5;

// localStorage key for per-Unit Flow assignments ({ [unit.label]: flowId }).
const ASSIGN_KEY = 'flow-rts.assignments.v1';

// tileset layout: grass (0-2), hill autotile (3-18), shadow (19), ramp (20), ramp-ground (21)
// hill autotile index = T_HILL_BASE + bitmask
// bitmask bits: 0=N exposed, 1=S exposed, 2=E exposed, 3=W exposed
const T_GRASS_A   = 0;
const T_GRASS_B   = 1;
const T_GRASS_C   = 2;
const T_HILL_BASE = 3;   // indices 3..18
const T_SHADOW    = 19;
const T_RAMP      = 20;
const T_RAMP_GND  = 21;

function mkRNG(seed) {
  let s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s = (s >>> 0) || 1) / 0x100000000;
  };
}

export class MapScene extends Phaser.Scene {
  constructor() { super('MapScene'); }

  preload() {
    this.load.image('unit_shadow', '/sprites/unit_shadow.png');
    this.load.image('tileset', '/sprites/terrain/tileset.png');
    this.load.image('command_center', '/sprites/command_center.png');
    this.load.image('barracks', '/sprites/barracks.png');
    this.load.image('factory', '/sprites/factory.png');
    const UNIT_TYPES = ['worker', 'marine', 'mech', 'zapper', 'tank', 'reaper', 'biter', 'chojin', 'heavy-chojin'];
    const UNIT_DIRS  = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'dead'];
    for (const type of UNIT_TYPES)
      for (const d of UNIT_DIRS) this.load.image(`${type}_${d}`, `/sprites/${type}_${d}.png`);
    for (const key of DECORATIONS.tree.sprites) this.load.image(key, `/sprites/${key}.png`);
    for (const key of DECORATIONS.obstacle.sprites) this.load.image(key, `/sprites/decor2/${key}.png`);
    for (const key of DECORATIONS.groundDecor.sprites) this.load.image(key, `/sprites/decor2/${key}.png`);
    for (const key of RESOURCES.alloys.sprites)   this.load.image(key, `/sprites/${key}.png`);
    for (const key of RESOURCES.sludge.sprites)   this.load.image(key, `/sprites/${key}.png`);
    for (const key of RESOURCES.biopulp.sprites)  this.load.image(key, `/sprites/${key}.png`);
  }

  create() {
    // DOM overlay for labels and health bars — must be created before any units/buildings are
    // registered, since _registerUnit/_registerBuilding append to it immediately.
    const uiOverlay = document.createElement('div');
    uiOverlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden';
    document.body.appendChild(uiOverlay);
    this._uiOverlay = uiOverlay;

    // The simulation starts paused: no Flow ticks and no Unit movement until START is pressed
    // (docs/adr/0005). Set before spawning Units so their Runs don't begin at assignment.
    this._running = false;

    // Shared Tile-occupancy layer (docs/adr/0009): `${tx},${ty}` → { kind, blocking }. Every
    // footprint feature (Deposit, Decoration, Building) registers here. Spawn rejects a
    // placement if any of its Footprint Tiles is occupied; walkable() blocks on blocking ones.
    this._occupied = new Map();

    // Deposits (docs/adr/0008): a list plus a Tile→Deposit lookup the gather code consults.
    // Deposits also register in the occupancy layer above.
    this._deposits = [];
    this._depositByTile = new Map(); // `${tx},${ty}` → Deposit

    // The player's Stockpile (docs/adr/0008): Resource id → amount, grown when a Worker delivers
    // its Cargo at the command center. Shown in the materials panel. Seeded with starting alloys so
    // the player can afford an early Build before the first delivery lands (docs/adr/0018).
    this._stockpile = { alloys: 200 };

    // Buildings are Runners too (CONTEXT.md): they hold Assignments and Runs and are ticked
    // alongside Units. Enemy Flows are data-authored and live here, out of the Library (ADR-0011).
    this.buildings = [];
    // Construction Sites (docs/adr/0018): placed-but-unfinished Buildings raised by Worker crews.
    // Their own entities (not Buildings, not Runners), but they occupy footprints and take damage.
    this._sites = [];
    this._enemyFlows = new Map(); // flowId → FlowModel for spawned Enemies
    this._over = false;           // set once the Objective resolves (win/lose)
    this._enemySeq = 0;
    this._nextUnitId = 1; // global counter — every unit and building gets a unique number
    this._assignments = this._loadAssignments(); // { [runner.label]: flowId }, shared by buildings + units

    const { tiles, isHill, isRamp } = this._generateTerrain();
    this._isHill = isHill;
    this._isRamp = isRamp;
    this._drawProceduralGround();
    const groundOnly = new URLSearchParams(window.location.search).has('groundOnly');
    if (!groundOnly) this._buildTilemap(tiles);
    if (!groundOnly) this._spawnBuildings();   // reserve command-center footprint + start clearance first
    if (!groundOnly) this._placeAlloys();      // clustered alloy Deposits (docs/adr/0009)
    if (!groundOnly) this._placeSludge();      // sludge pools bubbling up from the ground (docs/adr/0009)
    if (!groundOnly) this._placeCarcasses();   // pre-placed biopulp deposits (docs/adr/0009)
    if (!groundOnly) this._placeDecorations(); // trees — scattered, no overlap (docs/adr/0009)
    this._critterFlowId = this._ensureCritterFlow();
    if (!groundOnly) this._spawnUnits();
    this._setupCamera();
    this.input.mouse?.disableContextMenu(); // allow right-click as a cancel gesture
    registerPositionPicker((opts) => this._beginPositionPick(opts));

    // The static-terrain + dynamic-steering movement layer (docs/adr/0007). Owns Unit Paths
    // and avoidance; the interpreter reaches it only through the world context below.
    this._movement = new MovementSystem({
      isWalkable: (tx, ty) => this.walkable(tx, ty),
      width: MAP_W,
      height: MAP_H,
    });

    // Combat layer (docs/adr/0012): acquires targets, drives chase/stop goals into the movement
    // system, and applies Damage. Engine-agnostic like movement — it reaches the game by callback.
    // Transient attack visuals (a laser bolt for ranged, a claw slash for melee) — fired here
    // because onAttack is exactly the moment a blow lands; the effect is render-only.
    this._effects = new AttackEffects(this);
    this._combat = new CombatSystem({
      targetsFor: (unit) => this._targetsFor(unit),
      onAttack: (attacker, target) => {
        const def = getUnitType(attacker.type);
        this._effects.show(attacker, target, def);
        this._log(`${attacker.label} attacks ${target.label}`);
        this._applyDamage(target, def?.damage || 0);
      },
      movement: this._movement,
    });

    // The world context handed to the Flow interpreter: the only surface through which a
    // node's effect reaches the game (docs/adr/0006). The interpreter has no Phaser; these
    // primitives do. Move sets a goal and reads whether the Unit has arrived; the actual
    // pathing/steering runs in update()'s movement pass.
    this._world = {
      moveToward: (unit, destTile, loose) => {
        // A plain Move ends any combat stance (docs/adr/0012): otherwise the combat pass would
        // keep stopping the Unit to fight and it could never leave its post. `loose` requests a
        // forgiving arrival so Units sharing a destination settle nearby (docs/adr/0017).
        if (unit.combat) unit.combat = null;
        this._movement.setGoal(unit, destTile.x, destTile.y, !!loose);
        return this._movement.arrived(unit);
      },
      position: (unit) => ({ x: unit.x, y: unit.y }),
      walkable: (tx, ty) => this.walkable(tx, ty),
      claimDeposit: (unit) => this._claimDeposit(unit),
      collect: (unit, deposit) => this._collect(unit, deposit),
      deliver: (unit) => this._deliver(unit),
      deliverTime: (unit) => this._deliverDuration(unit),
      test: (unit, params) => this._testCondition(unit, params),
      // Combat (docs/adr/0012): the executors set a combat intent; the CombatSystem resolves it.
      attackMove: (unit, dest) => this._setCombat(unit, 'attackmove', dest),
      hold: (unit) => this._setCombat(unit, 'hold', null),
      attackMoveArrived: (unit) => this._movement.arrived(unit) && !(unit.combat && unit.combat.engaged),
      roamDest: (unit) => this._roamDest(unit),
      // Production (docs/adr/0013): a building-scoped Action ticked on a Building Runner.
      train: (building, params, state, dt) => this._train(building, params, state, dt),
      // Construction (docs/adr/0018): Build places a Site; Construct claims a build slot and raises it.
      build: (building, params) => this._build(building, params),
      claimBuildSlot: (unit) => this._claimBuildSlot(unit),
      construct: (unit, site, dt) => this._construct(unit, site, dt),
      // An Interrupt preempting a Frame halts that Frame's in-flight intent (docs/adr/0019): drop
      // any movement goal so the Runner stops in place and clear any combat stance, so the handler
      // starts clean. Resuming re-asserts intent — Move/Hold/AttackMove re-issue it every tick — so
      // this only needs to stop, not remember. A Building has neither, hence the feature guards.
      suspendRunner: (runner) => {
        if (runner.mv) this._movement.stop(runner);
        if (runner.combat) runner.combat = null;
      },
    };

    this._scenarioState = { time: 0, next: 0 }; // wave-clock cursor (docs/adr/0014)

    // Live inspector: while the sim is running, clicking a Runner opens its Flow in the editor as
    // a docked, read-only panel with the running node highlighted (see _inspectRunner /
    // _syncInspector). While paused, a click assigns a Flow instead (the authoring gesture).
    this._selectedRunner = null;
    this._inspectFlowId = null;

    this._buildStartButton();
    this._buildMaterialsPanel();
    this._buildBanner();

  }

  // Per-frame loop (docs/adr/0005, 0007): while running, tick every Run (a running Move sets
  // its goal), then integrate movement for all Units at once (so idle Units also get shoved),
  // then sync sprites. Paused ⇒ nothing ticks and nothing moves.
  update(_time, delta) {
    if (!this.units) return;

    if (this._running && !this._over) {
      // Tick every Runner's Run — Units and Buildings alike (CONTEXT.md Runner). Buildings run
      // building-scoped Flows (Train); Units run movement/gather/combat Flows.
      for (const runner of this._runners()) this._tickRunner(runner, delta);

      // Combat resolves before movement so an engaging Unit holds its ground (docs/adr/0012),
      // then the movement pass integrates positions, then the Scenario advances its wave clock.
      this._combat.update(this.units, delta);
      this._movement.update(this.units, delta);
      this._updateScenario(delta);

      this._checkObjective();
    }

    // DOM labels and health bars must track screen position every frame regardless of running state,
    // since the camera can pan/zoom while paused.
    const cam = this.cameras.main;
    // Phaser camera matrix: screen = (world - scroll) * zoom + origin * (1 - zoom).
    // The origin offset term is zero at zoom=1 but drifts otherwise — must include it.
    const camOX = cam.width * cam.originX * (1 - cam.zoom);
    const camOY = cam.height * cam.originY * (1 - cam.zoom);
    for (const unit of this.units) this._placeUnit(unit, cam, camOX, camOY);
    for (const b of this.buildings) {
      this._drawBuildingProgress(b);
      if (b._progressBar) b._progressBar.setScale(1 / cam.zoom);
      if (b._ui) {
        const hbTopY = b.sprite.y - b.sprite.displayHeight - 8;
        const sx = (b._cx - cam.scrollX) * cam.zoom + camOX;
        const sy = (hbTopY - cam.scrollY) * cam.zoom + camOY;
        b._ui.el.style.left = sx + 'px';
        b._ui.el.style.top = sy + 'px';
        if (b.health > 0) {
          b._ui.hbBg.style.display = '';
          b._ui.hbFill.style.width = (b.health / b.maxHealth * 100) + '%';
        } else {
          b._ui.hbBg.style.display = 'none';
        }
      }
    }

    // Construction Sites track the camera the same way (docs/adr/0018): a Phaser progress bar in
    // world space (kept screen-constant via 1/zoom) plus a DOM health bar positioned by transform.
    for (const s of this._sites) {
      this._drawSiteProgress(s);
      if (s._progressBar) s._progressBar.setScale(1 / cam.zoom);
      if (s._ui) {
        const hbTopY = s.sprite.y - s.sprite.displayHeight - 8;
        s._ui.el.style.left = ((s._cx - cam.scrollX) * cam.zoom + camOX) + 'px';
        s._ui.el.style.top = ((hbTopY - cam.scrollY) * cam.zoom + camOY) + 'px';
        if (s.health > 0) {
          s._ui.hbBg.style.display = '';
          s._ui.hbFill.style.width = (s.health / s.maxHealth * 100) + '%';
        } else {
          s._ui.hbBg.style.display = 'none';
        }
      }
    }

    // Push the inspected Runner's live cursor to the editor every frame — also while paused, so
    // a freshly-clicked Runner highlights at once even before START.
    this._syncInspector();
  }

  // Every Runner currently on the map (Units + Buildings). Enemy Units are in `this.units`.
  _runners() { return [...this.units, ...this.buildings]; }

  // Advance one Runner's Run against its live Flow model. Player Flows resolve from the Library;
  // Enemy Flows are data-authored and resolve from the Scenario's registry (docs/adr/0011, 0014).
  _tickRunner(runner, delta) {
    const run = runner.run;
    if (!run || run.status !== 'running') return;
    const model = this._resolveFlow(run.flowId);
    if (!model) { run.status = 'halted'; return; }
    const prevNode = run.current;
    tickRun(run, runner, model, this._world, delta);
    if (run.current !== prevNode && run.current) {
      const node = model.getNode(run.current);
      if (node && node.kind !== 'OnStart') this._log(`${runner.label} ▶ ${this._nodeDesc(node)}`);
    }
    if (run.status === 'idle') this._log(`${runner.label} flow complete`);
    if (run.status === 'halted') this._log(`${runner.label} flow halted (node deleted)`);
  }

  _resolveFlow(flowId) {
    const entry = flowLibrary.get(flowId);
    if (entry) return entry.model;
    return this._enemyFlows.get(flowId) || null;
  }

  // ── combat & death (docs/adr/0012) ───────────────────────────────────────────

  // Apply Damage to a Runner; if it dies, remove it. The Command Center falling ends the level.
  _applyDamage(target, amount) {
    if (!target || target.health <= 0) return;
    const died = applyDamage(target, amount);
    this._log(`${target.label} takes ${amount} damage — Health: ${target.health}/${target.maxHealth}`);
    if (died) {
      this._log(`${target.label} is destroyed`);
      // A Construction Site isn't a Runner (docs/adr/0018): tear it down its own way.
      if (this._sites.includes(target)) this._destroySite(target);
      else this._destroyRunner(target);
    }
  }

  _destroyRunner(runner) {
    runner._shadow?.destroy();
    runner.sprite?.destroy();
    if (runner._ui) { runner._ui.el.remove(); runner._ui = null; }
    if (runner._progressBar) { runner._progressBar.destroy(); runner._progressBar = null; }
    this._releaseClaim(runner); // a destroyed Worker frees its Deposit (docs/adr/0017)
    this._releaseBuildSlot(runner); // and its build slot at a Construction Site (docs/adr/0018)
    runner.run = null;

    // If we were inspecting this Runner, close the panel — there's nothing left to watch.
    if (runner === this._selectedRunner) this._stopInspecting();

    if (this.units.includes(runner)) {
      this.units = this.units.filter((u) => u !== runner);
      // Non-player biological units leave a harvestable biopulp Deposit (CONTEXT.md).
      if (runner.faction !== FACTION.PLAYER) this._spawnBiopulpDeposit(runner.tx, runner.ty);
    } else if (this.buildings.includes(runner)) {
      // Free the Building's Footprint so Units can path/stand there (docs/adr/0009).
      for (let dy = 0; dy < runner.tileH; dy++)
        for (let dx = 0; dx < runner.tileW; dx++)
          this._occupied.delete(`${runner.tx + dx},${runner.ty + dy}`);
      this.buildings = this.buildings.filter((b) => b !== runner);
      if (runner === this._commandCenter) this._endLevel(false); // base lost ⇒ defeat
    }
  }

  // Enemy targets for a Unit: every alive Runner of the opposing Faction, as a point + radius
  // the CombatSystem range-checks against (docs/adr/0012).
  _targetsFor(unit) {
    const out = [];
    for (const u of this.units)
      if (u !== unit && u.faction !== unit.faction && u.health > 0)
        out.push({ entity: u, x: u.x, y: u.y - TILE * 0.4, radius: TILE * 0.3 });
    for (const b of this.buildings)
      if (b.faction !== unit.faction && b.health > 0)
        out.push({
          entity: b,
          x: (b.tx + b.tileW * 0.5) * TILE,
          y: (b.ty + b.tileH * 0.5) * TILE,
          radius: b.tileW * TILE * 0.5,
        });
    // Construction Sites are destructible too (docs/adr/0018): an Enemy can raze a half-built structure.
    for (const s of this._sites)
      if (s.faction !== unit.faction && s.health > 0)
        out.push({
          entity: s,
          x: (s.tx + s.tileW * 0.5) * TILE,
          y: (s.ty + s.tileH * 0.5) * TILE,
          radius: s.tileW * TILE * 0.5,
        });
    return out;
  }

  // Set/refresh a Unit's combat intent (docs/adr/0012). Re-issuing the same intent preserves the
  // attack cooldown; a genuinely new intent (mode or Attack-Move destination changed) resets it.
  _setCombat(unit, mode, dest) {
    const c = unit.combat;
    const sameDest = !dest || (c && c.dest && c.dest.x === dest.x && c.dest.y === dest.y);
    if (!c || c.mode !== mode || (mode === 'attackmove' && !sameDest)) {
      unit.combat = { mode, dest: dest ? { ...dest } : null, cooldown: 0, engaged: false };
      // Kick off travel immediately so the Attack-Move executor doesn't see the default
      // "arrived" state and complete on its first tick. The combat pass refines the goal
      // (chase / resume) from here.
      if (mode === 'attackmove' && dest) this._movement.setGoal(unit, dest.x, dest.y);
    }
  }

  // ── production (docs/adr/0013) ───────────────────────────────────────────────

  // Train executor backend: block (return false) until the Stockpile affords the unit type's
  // cost, then deduct it, wait the build time, spawn beside the Building, and assign the Flow to
  // the new Unit. Returns true once the Unit is produced. `state` is the per-node Run scratch.
  _train(building, params, state, dt) {
    const def = getUnitType(params.unitType);
    if (!def) return true; // nothing selected — advance
    if (def.producedBy !== building.type) return true; // this Building can't make it (docs/adr/0016)
    if (!state.started) {
      if (!this._canAfford(def.cost)) return false; // block until affordable
      this._spend(def.cost);
      state.started = true;
      state.elapsed = 0;
      state.duration = def.buildTime * 1000; // read by the building progress bar + inspector
    }
    state.elapsed += dt;
    if (state.elapsed < def.buildTime * 1000) return false; // building…
    this._spawnTrainedUnit(building, def, params.assignFlow || null);
    return true;
  }

  _canAfford(cost) {
    for (const [res, amt] of Object.entries(cost || {}))
      if ((this._stockpile[res] || 0) < amt) return false;
    return true;
  }

  _spend(cost) {
    for (const [res, amt] of Object.entries(cost || {}))
      this._stockpile[res] = (this._stockpile[res] || 0) - amt;
    this._updateMaterialsPanel();
  }

  _spawnTrainedUnit(building, def, flowId) {
    const spot = this._freeTileNear(building);
    if (!spot) return; // surrounded — drop this product (best-effort, docs/adr/0009)
    const unit = this._createUnit(def.id, spot.x, spot.y, building.faction);
    if (!unit) return;
    if (building.faction === FACTION.PLAYER) {
      unit.assignedFlowId = flowId && flowLibrary.get(flowId) ? flowId : null;
      this._startRun(unit); // born running its assigned Flow (docs/adr/0013)
    }
    this._refreshUnitLabel(unit);
  }

  // First free walkable Tile on rings expanding out from just below a Building's Footprint.
  _freeTileNear(b) {
    const cx = b.tx + (b.tileW >> 1);
    const cy = b.ty + b.tileH;
    for (let r = 1; r <= 14; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx, ty = cy + dy;
          if (this.walkable(tx, ty) && !this._isHill(tx, ty - 1)) return { x: tx, y: ty };
        }
    return null;
  }

  // Build the DOM label+health-bar cluster for a Runner. Appended to _uiOverlay and positioned
  // each frame in world→screen space, so it is immune to camera zoom (outside Phaser pipeline).
  _createRunnerUI(barW) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute';

    const labels = document.createElement('div');
    labels.style.cssText = 'position:absolute;left:0;top:-2px;display:flex;flex-direction:column;align-items:center;gap:2px;transform:translate(-50%,-100%)';

    const flowEl = document.createElement('div');
    flowEl.style.cssText = 'font:13px/1.2 system-ui,sans-serif;color:#7df9ff;background:rgba(0,0,0,.55);padding:2px 5px;white-space:nowrap;display:none';

    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font:13px/1.2 system-ui,sans-serif;color:#b8bec8;background:rgba(0,0,0,.55);padding:2px 5px;white-space:nowrap';

    labels.append(flowEl, nameEl);

    const hbBg = document.createElement('div');
    hbBg.style.cssText = `position:absolute;left:0;top:0;width:${barW}px;height:5px;background:#5a0000;transform:translateX(-50%);display:none`;

    const hbFill = document.createElement('div');
    hbFill.style.cssText = 'width:0;height:100%;background:#dd1111';

    hbBg.appendChild(hbFill);
    el.append(labels, hbBg);
    return { el, labels, nameEl, flowEl, hbBg, hbFill };
  }

  // Create a Unit of a type at a Tile, wire its label/selectability, and register it. Does not
  // start a Run — the caller assigns a Flow (player) or a data-authored model (Enemy) first.
  _createUnit(typeId, tx, ty, faction) {
    const Cls = UNIT_CLASS[typeId];
    if (!Cls) return null;
    const unit = new Cls(this, tx * TILE + TILE * 0.5, ty * TILE + TILE, faction);
    unit.label = `${getUnitType(typeId)?.label || typeId} ${this._nextUnitId++}`;
    unit.sprite.setInteractive({ useHandCursor: true });
    unit.sprite.setData('unit', unit);
    const ui = this._createRunnerUI(unit._displaySize * 0.8);
    this._uiOverlay.appendChild(ui.el);
    unit._ui = ui;
    this.units.push(unit);
    return unit;
  }

  // ── construction (docs/adr/0018) ─────────────────────────────────────────────

  // Build executor backend: place a Construction Site of the chosen type at the chosen Footprint,
  // then let Build advance. Unlike Train (which blocks until affordable), an unaffordable or
  // blocked Build is a NO-OP that still advances — the Command Center isn't held up (docs/adr/0018).
  _build(building, params) {
    const def = getBuildingType(params.buildingType);
    if (!def || !def.buildable) return;          // nothing / non-buildable selected — no-op
    const anchor = params.destination;
    if (!anchor) return;                          // unset Location — no-op (ADR-0004)
    if (!this._footprintBuildable(anchor.x, anchor.y, def.tileW, def.tileH)) {
      this._log(`Build ${def.label}: footprint at (${anchor.x}, ${anchor.y}) is blocked`);
      return;                                     // blocked since authoring — no-op + advance
    }
    if (!this._canAfford(def.cost)) {
      this._log(`Build ${def.label}: not enough resources`);
      return;                                     // can't afford — no-op + advance (not blocking)
    }
    this._spend(def.cost);
    this._placeSite(def, anchor.x, anchor.y, params.assignFlow || null, building.faction);
  }

  // Place a Construction Site: block its Footprint (docs/adr/0009) and register it for ticking,
  // damage, and rendering. It carries the Build node's optional assignFlow, applied to the finished
  // Building when construction completes (docs/adr/0018).
  _placeSite(def, tx, ty, assignFlowId, faction) {
    this._occupy(tx, ty, def.tileW, def.tileH, 'construction', true);
    const site = new ConstructionSite(this, tx, ty, def, faction);
    site.label = `${def.label} (site)`;
    site.assignFlowId = assignFlowId && flowLibrary.get(assignFlowId) ? assignFlowId : null;
    // DOM label + health bar, like a Building's (the bar's the only damage cue while it builds).
    const ui = this._createRunnerUI(def.tileW * TILE * 0.7);
    this._uiOverlay.appendChild(ui.el);
    ui.nameEl.textContent = site.label;
    site._ui = ui;
    this._sites.push(site);
    this._log(`Construction started: ${def.label} at (${tx}, ${ty})`);
  }

  // Construct executor backend: claim one of the nearest reachable Site's ≤4 build slots, mirroring
  // _claimDeposit (docs/adr/0017). Reach-limited like Gather — only Sites within CLAIM_RADIUS of
  // where the Worker stands. Returns an opaque handle + a Tile to stand on beside the Footprint,
  // or null when no Site in reach needs builders (so the Worker waits in place).
  _claimBuildSlot(unit) {
    const { x: ux, y: uy } = this._unitTile(unit);
    // Already holding a slot on a live Site? Keep it (refresh the standing Tile).
    if (unit._buildSlot && this._sites.includes(unit._buildSlot)) {
      const site = unit._buildSlot;
      return { handle: site, dest: this._standingTileBesideFootprint(site, ux, uy) || { x: ux, y: uy } };
    }
    let best = null, bestStand = null, bestD = Infinity;
    for (const site of this._sites) {
      if (site.faction !== unit.faction) continue;                  // build only your own
      if (site.builders.size >= 4 && !site.builders.has(unit)) continue; // full — four builders max
      // Chebyshev distance from the Worker to the Footprint rectangle, in Tiles (rally reach).
      const dx = Math.max(site.tx - ux, ux - (site.tx + site.tileW - 1), 0);
      const dy = Math.max(site.ty - uy, uy - (site.ty + site.tileH - 1), 0);
      if (Math.max(dx, dy) > CLAIM_RADIUS) continue;                // out of reach — ignore
      const d = dx * dx + dy * dy;
      if (d >= bestD) continue;
      const stand = this._standingTileBesideFootprint(site, ux, uy);
      if (!stand) continue;                                         // hemmed in — unreachable
      best = site; bestStand = stand; bestD = d;
    }
    if (!best) return null;                                         // none in reach — wait in place
    this._releaseBuildSlot(unit);                                   // drop any prior slot
    best.builders.add(unit);
    unit._buildSlot = best;
    return { handle: best, dest: bestStand };
  }

  // A free Walkable Tile on the ring just outside a Site's Footprint, nearest to (fromX,fromY) —
  // where a Worker stands to build. null when the Footprint is fully hemmed in.
  _standingTileBesideFootprint(site, fromX, fromY) {
    let best = null, bestD = Infinity;
    for (let y = site.ty - 1; y <= site.ty + site.tileH; y++)
      for (let x = site.tx - 1; x <= site.tx + site.tileW; x++) {
        const inside = x >= site.tx && x < site.tx + site.tileW && y >= site.ty && y < site.ty + site.tileH;
        if (inside || !this.walkable(x, y)) continue;
        const d = (x - fromX) ** 2 + (y - fromY) ** 2;
        if (d < bestD) { best = { x, y }; bestD = d; }
      }
    return best;
  }

  // Add one builder-tick of work to a Site (docs/adr/0018). Each arrived builder calls this once a
  // frame, so N builders accrue N×dt — the linear "more Workers ⇒ faster" rule, capped at 4 by the
  // slot limit. Returns true (advance the Worker + free its slot) when the Site completes or has
  // already gone (finished or razed under it).
  _construct(unit, site, dt) {
    if (!this._sites.includes(site)) { this._releaseBuildSlot(unit); return true; }
    site.buildProgress += dt;
    if (site.buildProgress < site.buildDuration) return false;     // still building
    this._completeSite(site);
    return true;
  }

  // Construction finished: free the Site, raise the real Building of that type in its place, and
  // hand it the Build node's chosen Flow so it is born running (docs/adr/0018).
  _completeSite(site) {
    this._sites = this._sites.filter((s) => s !== site);
    this._clearSite(site);
    const Cls = BUILDING_CLASS[site.type];
    if (!Cls) return;
    this._occupy(site.tx, site.ty, site.tileW, site.tileH, 'building', true);
    const b = new Cls(this, site.tx, site.ty);
    this._registerBuilding(b, getBuildingType(site.type)?.label || site.type, site.assignFlowId);
    this._log(`${b.label} construction complete`);
  }

  // A Site razed mid-build (docs/adr/0018): free its Footprint and tear it down. The spent cost is
  // gone — no refund (CONTEXT.md Construction Site).
  _destroySite(site) {
    this._sites = this._sites.filter((s) => s !== site);
    for (let dy = 0; dy < site.tileH; dy++)
      for (let dx = 0; dx < site.tileW; dx++)
        this._occupied.delete(`${site.tx + dx},${site.ty + dy}`);
    this._clearSite(site);
  }

  // Shared teardown: release every attached builder's slot and destroy the Site's sprites/bars.
  // _destroySite frees the Footprint; _completeSite re-occupies it as a Building, so freeing the
  // occupancy lives in the callers, not here.
  _clearSite(site) {
    for (const u of site.builders) u._buildSlot = null;
    site.builders.clear();
    if (site._ui) { site._ui.el.remove(); site._ui = null; }
    site._progressBar?.destroy();
    site.sprite.destroy();
  }

  // Release a Worker's build slot so another can take it (docs/adr/0018). Idempotent. Mirrors
  // _releaseClaim; called when the Site ends, the Worker is re-assigned, or it is destroyed.
  _releaseBuildSlot(unit) {
    const site = unit && unit._buildSlot;
    if (!site) return;
    site.builders.delete(unit);
    unit._buildSlot = null;
  }

  // Draw a Site's amber construction progress bar above it and fade the sprite from transparent to
  // solid (docs/adr/0018). Amber keeps it distinct from production-blue / gather-green / deliver-yellow.
  _drawSiteProgress(site) {
    site.syncVisual();
    const g = site._progressBar || (site._progressBar = this.add.graphics());
    const w = site.tileW * TILE * 0.7, h = 6;
    const x = site._cx - w / 2;
    const y = site.sprite.y - site.sprite.displayHeight - 16; // just above the Health bar
    g.clear();
    g.fillStyle(0x2a1a06, 1).fillRect(x, y, w, h);
    g.fillStyle(0xffa033, 1).fillRect(x, y, w * site.progressFrac, h);
    g.setDepth(2e6).setVisible(true);
  }

  // ── scenario: waves & objective (docs/adr/0014) ──────────────────────────────

  // Advance the wave clock and release any Wave whose scheduled time has arrived.
  _updateScenario(delta) {
    const st = this._scenarioState;
    st.time += delta / 1000;
    while (st.next < SCENARIO.waves.length && st.time >= SCENARIO.waves[st.next].at) {
      this._spawnWave(SCENARIO.waves[st.next]);
      st.next++;
    }
  }

  _spawnWave(wave) {
    const origin = this._spawnPoint(wave.spawn);
    const target = this._enemyTargetTile();
    for (let i = 0; i < wave.count; i++) {
      // Fan the group out around the spawn origin so they don't all stack on one Tile.
      const spot = this._freeWalkableNear(origin.x + ((i % 3) - 1) * 2, origin.y + (((i / 3) | 0) - 1) * 2);
      if (spot) this._spawnEnemy(wave.unitType, spot, target);
    }
  }

  // Spawn one Enemy Unit running a data-authored rush Flow (kept out of the Library, ADR-0011).
  _spawnEnemy(typeId, spot, target) {
    const unit = this._createUnit(typeId, spot.x, spot.y, FACTION.ENEMY);
    if (!unit) return;
    const id = `enemy_${++this._enemySeq}`;
    const model = enemyFlowModel(target);
    this._enemyFlows.set(id, model);
    unit.assignedFlowId = id;
    unit.run = startRun(id, model);
    if (unit._ui) unit._ui.nameEl.style.color = '#ff6b6b';
    this._refreshUnitLabel(unit);
  }

  // Map a named spawn point to an edge Tile, snapped to the nearest walkable Tile.
  _spawnPoint(name) {
    const mx = MAP_W >> 1, my = MAP_H >> 1;
    const raw = name === 'right'  ? { x: MAP_W - 3, y: my }
              : name === 'top'    ? { x: mx, y: 3 }
              : name === 'bottom' ? { x: mx, y: MAP_H - 3 }
              : /* left */          { x: 3, y: my };
    return this._freeWalkableNear(raw.x, raw.y) || raw;
  }

  // The Tile Enemies Attack-Move toward: just below the Command Center, snapped to walkable.
  _enemyTargetTile() {
    const cc = this._commandCenter;
    if (!cc) return { x: MAP_W >> 1, y: MAP_H >> 1 };
    return this._freeWalkableNear(cc.tx + (cc.tileW >> 1), cc.ty + cc.tileH + 1)
      || { x: cc.tx, y: cc.ty + cc.tileH };
  }

  // Nearest walkable, non-blocked Tile spiralling out from (tx,ty).
  _freeWalkableNear(tx, ty) {
    for (let r = 0; r <= 20; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (this.walkable(x, y) && !this._isHill(x, y - 1)) return { x, y };
        }
    return null;
  }

  // Create (or find) the shared critter roam Flow in the Library. Returns its id.
  // Skips creation if a protected unit Flow already exists (survives reloads via localStorage).
  _ensureCritterFlow() {
    const existing = flowLibrary.list().find((e) => e.protected && e.model.targetKind === 'unit');
    if (existing) return existing.id;
    const entry = flowLibrary.create('Biter Roam');
    entry.model = critterFlowModel();
    entry.protected = true;
    flowLibrary.save();
    return entry.id;
  }

  // Pick a random walkable tile within ROAM_RADIUS tiles of the unit, used by RoamAttack.
  _roamDest(unit) {
    const ROAM_RADIUS = 15;
    const tx = Math.floor(unit.x / TILE);
    const ty = Math.floor((unit.y - TILE * 0.5) / TILE);
    for (let i = 0; i < 25; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 5 + Math.random() * ROAM_RADIUS;
      const nx = Math.round(tx + Math.cos(angle) * r);
      const ny = Math.round(ty + Math.sin(angle) * r);
      if (nx >= 0 && nx < MAP_W && ny >= 0 && ny < MAP_H && this.walkable(nx, ny)) {
        return { x: nx, y: ny };
      }
    }
    return { x: tx, y: ty };
  }

  // Objective check each frame (docs/adr/0014): victory once every Wave has spawned and no
  // Enemy remains alive. Defeat (Command Center lost) is triggered from _destroyRunner.
  _checkObjective() {
    if (this._over) return;
    const allWavesOut = this._scenarioState.next >= SCENARIO.waves.length;
    const enemiesLeft = this.units.some((u) => u.faction === FACTION.ENEMY && u.health > 0);
    if (allWavesOut && !enemiesLeft) this._endLevel(true);
  }

  _endLevel(won) {
    if (this._over) return;
    this._over = true;
    this._running = false;
    this._updateStartBtn();
    this._showBanner(won ? 'VICTORY — base survived' : 'DEFEAT — Command Center lost', won);
  }

  // A Tile is Walkable if it is lowland ground or a ramp (hill tops are not) AND not held by a
  // blocking occupant — a Deposit, a blocking Decoration, or a Building (CONTEXT.md, ADR-0009).
  // Non-blocking occupants (e.g. trees) reserve a Tile for spawning but stay Walkable.
  walkable(tx, ty) {
    if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return false;
    const occ = this._occupied.get(`${tx},${ty}`);
    if (occ && occ.blocking) return false;
    return !(this._isHill(tx, ty) && !this._isRamp(tx, ty));
  }

  // ── terrain generation ────────────────────────────────────────────────────

  _generateTerrain() {
    const buf = new Uint8Array(MAP_W * MAP_H); // 0=grass, 1=hill, 2=ramp
    const r = mkRNG(42);

    for (let i = 0; i < 16; i++) {
      const cx = (r() * (MAP_W - 28) + 14) | 0;
      const cy = (r() * (MAP_H - 28) + 14) | 0;
      const rx = (r() * 10 + 5) | 0;
      const ry = (r() * 6  + 4) | 0;
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) {
            if ((dx / rx) ** 2 + (dy / ry) ** 2 <= 1) buf[y * MAP_W + x] = 1;
          }
        }
      }
    }

    // ramps are still elevated (buf >= 1) but rendered as paths not cliffs
    this._placeRamps(buf);

    const isHill = (x, y) =>
      x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && buf[y * MAP_W + x] >= 1;
    const isRamp = (x, y) =>
      x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && buf[y * MAP_W + x] === 2;

    const tiles = Array.from({ length: MAP_H }, (_, y) =>
      Array.from({ length: MAP_W }, (_, x) => {
        const cell = buf[y * MAP_W + x];

        if (cell === 2) return T_RAMP;

        if (cell === 1) {
          let mask = 0;
          if (!isHill(x, y - 1)) mask |= 1; // N exposed
          if (!isHill(x, y + 1)) mask |= 2; // S exposed
          if (!isHill(x + 1, y)) mask |= 4; // E exposed
          if (!isHill(x - 1, y)) mask |= 8; // W exposed
          return T_HILL_BASE + mask;
        }

        // grass — check for shadow or ramp-ground
        if (isRamp(x, y - 1)) return T_RAMP_GND;
        if (isHill(x, y - 1)) return T_SHADOW;
        return (x * 3 + y * 11) % 3; // T_GRASS_A/B/C
      })
    );

    return { tiles, isHill, isRamp };
  }

  // punch 2-wide ramps into south-facing cliff runs of ≥5 tiles
  _placeRamps(buf) {
    const r = mkRNG(77);
    for (let y = 2; y < MAP_H - 2; y++) {
      let runStart = -1;
      for (let x = 0; x <= MAP_W; x++) {
        const cliff = x < MAP_W &&
          buf[y * MAP_W + x] === 1 &&
          buf[(y + 1) * MAP_W + x] === 0;

        if (cliff && runStart === -1) {
          runStart = x;
        } else if (!cliff && runStart !== -1) {
          const runLen = x - runStart;
          if (runLen >= 5) {
            // keep at least 1 cliff cell on each side of the ramp
            const off = (r() * (runLen - 4)) | 0;
            const rx  = runStart + 1 + off;
            buf[y * MAP_W + rx]     = 2;
            buf[y * MAP_W + rx + 1] = 2;
          }
          runStart = -1;
        }
      }
    }
  }

  // ── tilemap ───────────────────────────────────────────────────────────────

  _buildTilemap(tiles) {
    const map = this.make.tilemap({ data: tiles, tileWidth: TILE, tileHeight: TILE });
    const ts  = map.addTilesetImage('tileset', 'tileset', TILE, TILE, EXTRUDE, 2 * EXTRUDE);
    map.createLayer(0, ts, 0, 0).setDepth(-50);
  }

  // ── procedural ground ────────────────────────────────────────────────────────

  // GPU fragment shader covering the full map in world space.
  // Camera scroll/zoom are applied automatically by Phaser's projection matrix.
  //
  // Techniques:
  //   Hash:    Dave Hoskins float hash (no sin)
  //   Warp:    IQ double domain warping for organic shapes
  //   Voronoi: IQ two-pass perpendicular bisector (uniform crevice width)
  //   Normal:  finite differences (3 height samples)
  //   Layers:  large brown rocks → grey sand fill → grey pebbles (3 scales)
  _drawProceduralGround() {
    const fragSrc = `
precision highp float;
varying vec2 fragCoord;
uniform vec2 resolution;

float h12(vec2 p){
  vec3 q=fract(vec3(p.xyx)*0.1031);q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
vec2 h22(vec2 p){
  vec3 q=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));q+=dot(q,q.yzx+33.33);
  return fract((q.xx+q.yz)*q.zy);
}
float vn(vec2 p){
  vec2 i=floor(p);vec2 f=fract(p);
  vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(h12(i),h12(i+vec2(1,0)),u.x),
             mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<4;i++){v+=a*vn(p);p*=2.0;a*=0.5;}
  return v/0.9375;
}
// 3-octave cheap fbm for large-scale fields (biomes, macro, lava zones)
float fbmL(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<3;i++){v+=a*vn(p);p*=2.0;a*=0.5;}
  return v/0.875;
}
float voronoiEdge(vec2 x,out float cellId){
  vec2 p=floor(x);vec2 f=fract(x);
  vec2 mr=vec2(0);vec2 mb=vec2(0);float minD=9.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 b=vec2(float(i),float(j));
    vec2 r=b+h22(p+b)-f;
    float d=dot(r,r);
    if(d<minD){minD=d;mr=r;mb=b;}
  }
  cellId=h12(p+mb);
  float edgeD=9.0;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
    vec2 b=mb+vec2(float(i),float(j));
    vec2 r=b+h22(p+b)-f;
    vec2 dv=r-mr;
    if(dot(dv,dv)>0.0001)
      edgeD=min(edgeD,dot(0.5*(mr+r),normalize(dv)));
  }
  return edgeD;
}

void main(void){
  vec2 world=vec2(fragCoord.x, resolution.y-fragCoord.y);
  vec2 p=world/6.0;

  // macro elevation — large regional brightness variation
  float macro=fbmL(p*0.10+vec2(4.5,1.2));

  // terrain biomes: rocky (default), dusty flat sheets, charred gashes
  float dustN=fbmL(p*0.038+vec2(2.2,5.8));
  float charN=fbmL(p*0.072+vec2(8.4,3.1));
  float wDusty=smoothstep(0.38,0.62,dustN);
  float wCharred=smoothstep(0.65,0.82,charN)*(1.0-wDusty);
  float wRocky=max(0.0,1.0-wDusty-wCharred);

  // lava hot zones: large rare spatial clusters, only in rocky biome
  float lavaTend=fbmL(p*0.025+vec2(7.1,3.4));
  float lavaZone=smoothstep(0.72,0.86,lavaTend)*wRocky;

  // domain warp for organic crack shapes
  vec2 q=vec2(fbm(p),fbm(p+vec2(5.2,1.3)));
  vec2 wp=p+0.50*q;
  vec2 rv=vec2(fbm(wp*1.9+vec2(1.7,9.2)),fbm(wp*1.9+vec2(8.3,2.8)));
  wp+=0.22*rv;

  // primary cracks — width varies by biome and macro
  float c1;
  float e1=voronoiEdge(wp*0.38,c1);
  float crackW=mix(0.05+0.14*(1.0-macro),0.050,wDusty);
  crackW=mix(crackW,0.038,wCharred);
  float crackMask=1.0-smoothstep(0.0,crackW,e1);
  float ao=0.60+0.40*smoothstep(0.0,crackW*2.5,e1);

  // secondary cracks — dense in charred terrain, sparse in dust
  float c2;
  float e2=voronoiEdge(wp*1.3+vec2(5.3,2.7),c2);
  float fineCrack=1.0-smoothstep(0.0,0.055,e2);
  float fineCrackStr=0.35*wRocky+0.18*wDusty+0.68*wCharred;

  // bump normals: tall lumpy rock, flat dust sheets, medium char
  float bumpAmp=(6.0+10.0*macro)*wRocky+1.5*wDusty+3.5*wCharred;
  float g0=fbm(wp*2.0+vec2(1.1,0.7));
  float ep=0.34;
  float gnx=fbm(wp*2.0+vec2(1.1+ep,0.7))-g0;
  float gny=fbm(wp*2.0+vec2(1.1,0.7+ep))-g0;
  vec3 N=normalize(vec3(gnx*bumpAmp,gny*bumpAmp,1.0));

  float grain=fbm(wp*6.0+vec2(3.3,7.1));
  float finegrain=fbm(wp*13.0+vec2(6.6,2.4));
  float noise=grain*0.60+finegrain*0.40;

  vec3 L1=normalize(vec3(0.70,0.0,0.71));
  vec3 L2=normalize(vec3(0.0,0.70,0.71));
  float diff=max(max(0.0,dot(N,L1)),max(0.0,dot(N,L2)));

  float rv2=h12(floor(wp*0.38)+vec2(3.1,7.9));
  float cv=c1*0.010;

  // biome surface colors
  vec3 rockBase=vec3(0.330+cv*0.4,0.278+cv*0.32,0.228+cv*0.26)*(0.88+0.24*rv2);
  vec3 rockCrev=vec3(0.110+cv*0.18,0.078+cv*0.13,0.055+cv*0.10);
  vec3 dustBase=vec3(0.380+cv*0.25,0.365+cv*0.22,0.342+cv*0.18)*(0.90+0.18*rv2);
  vec3 dustCrev=vec3(0.130,0.122,0.108);
  vec3 charBase=vec3(0.188+cv*0.18,0.168+cv*0.15,0.155+cv*0.12)*(0.85+0.28*rv2);
  vec3 charCrev=vec3(0.078,0.060,0.050);

  vec3 rockCol=wRocky*rockBase+wDusty*dustBase+wCharred*charBase;
  // crevice color gets grain modulation for textured crack appearance
  vec3 crevCol=(wRocky*rockCrev+wDusty*dustCrev+wCharred*charCrev)*(0.60+0.80*grain);
  float surfNoiseStr=0.42*wRocky+0.20*wDusty+0.50*wCharred;

  vec3 col=mix(rockCol,crevCol,crackMask);
  col*=ao;
  col*=(1.0-fineCrack*fineCrackStr);
  col*=(1.0-surfNoiseStr+2.0*surfNoiseStr*noise);
  col*=(0.46+0.54*diff);
  col*=(0.55+0.68*macro);

  // lava: additive emissive inside crack channels, tiny heat aura just outside
  // lavaActive clusters within hot zones (not uniform per-cell probability)
  float lavaSeed=h12(floor(wp*0.38)+vec2(9.3,2.8));
  float lavaActive=step(0.70,lavaSeed)*lavaZone;
  float lavaHeat=crackMask*crackMask;
  float lavaAura=max(0.0,1.0-e1/0.18)*(1.0-crackMask)*0.15;
  col+=vec3(1.20,0.62,0.02)*lavaHeat*lavaActive;
  col+=vec3(0.70,0.08,0.00)*lavaAura*lavaActive;

  col=max(col,vec3(0.032,0.022,0.016));
  gl_FragColor=vec4(col,1.0);
}
`;

    const base = new Phaser.Display.BaseShader('_gnd_shader', fragSrc, undefined, {});
    this.cache.shader.add('_gnd_shader', base);

    // world-space object: camera scroll/zoom move it naturally like any other sprite
    this._groundShader = this.add.shader('_gnd_shader', 0, 0, MAP_W * TILE, MAP_H * TILE)
      .setOrigin(0, 0)
      .setDepth(-200);
  }

  // ── occupancy (docs/adr/0009) ───────────────────────────────────────────────

  // A Tile is clear to place something on: in bounds (with a 1-Tile border), flat walkable
  // ground (no hill, ramp, or cliff-shadow), and not already occupied by anything.
  _groundClear(tx, ty) {
    if (tx < 1 || tx >= MAP_W - 1 || ty < 1 || ty >= MAP_H - 1) return false;
    if (this._isHill(tx, ty) || this._isRamp(tx, ty) || this._isHill(tx, ty - 1)) return false;
    return !this._occupied.has(`${tx},${ty}`);
  }

  // True if every Tile of a w×h Footprint anchored at (tx,ty) is clear.
  _footprintFree(tx, ty, w, h) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        if (!this._groundClear(tx + dx, ty + dy)) return false;
    return true;
  }

  // Like _groundClear, but for *placing a Building* (docs/adr/0018): only a BLOCKING occupant
  // rejects the Tile. A non-blocking occupant — ground decor, base clearance — is built over (the
  // Building's sprite covers it). Deposits, trees/obstacles, and other Buildings/Sites all block,
  // so they still reject. Same terrain rules as _groundClear (no hills/ramps, off the map edge).
  _tileBuildable(tx, ty) {
    if (tx < 1 || tx >= MAP_W - 1 || ty < 1 || ty >= MAP_H - 1) return false;
    if (this._isHill(tx, ty) || this._isRamp(tx, ty) || this._isHill(tx, ty - 1)) return false;
    const occ = this._occupied.get(`${tx},${ty}`);
    return !(occ && occ.blocking);
  }

  // True if every Tile of a w×h Footprint can take a Building (non-blocking occupants allowed).
  _footprintBuildable(tx, ty, w, h) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        if (!this._tileBuildable(tx + dx, ty + dy)) return false;
    return true;
  }

  // Mark a w×h Footprint occupied by `kind` (blocking or not) so spawning avoids it and, when
  // blocking, walkable() routes Units around it.
  _occupy(tx, ty, w, h, kind, blocking) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        this._occupied.set(`${tx + dx},${ty + dy}`, { kind, blocking });
  }

  // Reserve a non-blocking clearance rectangle (Footprint + margin) so nothing spawns there but
  // Units can still stand in it. Won't overwrite an existing (e.g. blocking) occupant.
  _reserveClearance(tx, ty, w, h, margin) {
    for (let y = ty - margin; y < ty + h + margin; y++)
      for (let x = tx - margin; x < tx + w + margin; x++) {
        const key = `${x},${y}`;
        if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && !this._occupied.has(key))
          this._occupied.set(key, { kind: 'clearance', blocking: false });
      }
  }

  // ── alloys ────────────────────────────────────────────────────────────────

  // Alloy Deposits spawn in contiguous blobs of 3–6: a seed Tile plus random adjacent free
  // Tiles, so each cluster reads as one tight patch (docs/adr/0009).
  _placeAlloys() {
    const r = mkRNG(1337);

    // A guaranteed starter cluster: the clear Tile nearest map centre (just outside the
    // command-center clearance), so Workers always have alloys to gather near the base.
    const starter = this._nearestClearTile((MAP_W / 2) | 0, (MAP_H / 2) | 0);
    if (starter) this._growAlloyCluster(starter, 4 + ((r() * 3) | 0), r); // 4–6

    const CLUSTERS = 22;
    for (let i = 0; i < CLUSTERS; i++) {
      let seed = null;
      for (let tries = 0; tries < 30 && !seed; tries++) {
        const tx = (r() * (MAP_W - 10) + 5) | 0;
        const ty = (r() * (MAP_H - 10) + 5) | 0;
        if (this._groundClear(tx, ty)) seed = { x: tx, y: ty };
      }
      if (seed) this._growAlloyCluster(seed, 3 + ((r() * 4) | 0), r);
    }
  }

  // Spiral outward from (cx,cy) for the closest clear Tile — used to anchor the starter alloy
  // cluster just beyond the reserved clearance around the command center.
  _nearestClearTile(cx, cy) {
    for (let radius = 0; radius <= 25; radius++)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
          if (this._groundClear(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
        }
    return null;
  }

  _growAlloyCluster(seed, target, r) {
    const placed = [];
    const place = (tx, ty) => {
      const img = this.add.image(tx * TILE + TILE * 0.5, ty * TILE + TILE * 0.5,
        RESOURCES.alloys.sprites[(r() * RESOURCES.alloys.sprites.length) | 0]);
      img.setOrigin(0.5, 0.5);
      img.setScale(TILE * (1.5 + r() * 1.0) / Math.max(img.width, img.height));
      img.setDepth(ty * TILE + TILE); // sort as if grounded at the Tile's bottom edge
      this._addDeposit('alloys', tx, ty, img); // registers Deposit + occupancy
      placed.push({ x: tx, y: ty });
    };
    place(seed.x, seed.y);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (placed.length < target) {
      const frontier = [];
      for (const p of placed)
        for (const [dx, dy] of DIRS) {
          const nx = p.x + dx, ny = p.y + dy;
          if (this._groundClear(nx, ny) && !frontier.some((f) => f.x === nx && f.y === ny))
            frontier.push({ x: nx, y: ny });
        }
      if (!frontier.length) break; // hemmed in — settle for a smaller cluster
      const pick = frontier[(r() * frontier.length) | 0];
      place(pick.x, pick.y);
    }
  }

  // ── sludge ────────────────────────────────────────────────────────────────

  // Sludge Deposits spawn in flat pools of 3–6: same blob growth as alloys but with a
  // different RNG seed so the two resources scatter independently (docs/adr/0009).
  _placeSludge() {
    const r = mkRNG(2718);
    const CLUSTERS = 18;
    for (let i = 0; i < CLUSTERS; i++) {
      let seed = null;
      for (let tries = 0; tries < 30 && !seed; tries++) {
        const tx = (r() * (MAP_W - 10) + 5) | 0;
        const ty = (r() * (MAP_H - 10) + 5) | 0;
        if (this._groundClear(tx, ty)) seed = { x: tx, y: ty };
      }
      if (seed) this._growSludgeCluster(seed, 3 + ((r() * 4) | 0), r);
    }
  }

  _growSludgeCluster(seed, target, r) {
    const placed = [];
    const place = (tx, ty) => {
      const img = this.add.image(tx * TILE + TILE * 0.5, ty * TILE + TILE * 0.5,
        RESOURCES.sludge.sprites[(r() * RESOURCES.sludge.sprites.length) | 0]);
      img.setOrigin(0.5, 0.5);
      img.setScale(TILE * (1.5 + r() * 1.0) / Math.max(img.width, img.height));
      img.setDepth(ty * TILE + TILE);
      this._addDeposit('sludge', tx, ty, img);
      placed.push({ x: tx, y: ty });
    };
    place(seed.x, seed.y);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (placed.length < target) {
      const frontier = [];
      for (const p of placed)
        for (const [dx, dy] of DIRS) {
          const nx = p.x + dx, ny = p.y + dy;
          if (this._groundClear(nx, ny) && !frontier.some((f) => f.x === nx && f.y === ny))
            frontier.push({ x: nx, y: ny });
        }
      if (!frontier.length) break;
      const pick = frontier[(r() * frontier.length) | 0];
      place(pick.x, pick.y);
    }
  }

  // ── biopulp ───────────────────────────────────────────────────────────────

  // Scatter pre-existing carcasses so the player has biopulp to harvest before the first wave
  // arrives. More appear dynamically as enemy and critter units die (_spawnBiopulpDeposit).
  _placeCarcasses() {
    const r = mkRNG(7777);
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      for (let tries = 0; tries < 30; tries++) {
        const tx = (r() * (MAP_W - 10) + 5) | 0;
        const ty = (r() * (MAP_H - 10) + 5) | 0;
        if (!this._groundClear(tx, ty)) continue;
        const sprites = RESOURCES.biopulp.sprites;
        const key = sprites[(r() * sprites.length) | 0];
        const img = this.add.image(tx * TILE + TILE * 0.5, ty * TILE + TILE * 0.5, key);
        img.setOrigin(0.5, 0.5);
        img.setScale(TILE * (1.5 + r() * 1.0) / Math.max(img.width, img.height));
        img.setDepth(ty * TILE + TILE);
        this._addDeposit('biopulp', tx, ty, img);
        break;
      }
    }
  }

  // Spawn a biopulp Deposit at a Tile when a non-player unit dies. Skipped if the Tile is
  // already occupied (two units dying in the same spot, a deposit already there, etc.).
  _spawnBiopulpDeposit(tx, ty) {
    if (this._depositByTile.has(`${tx},${ty}`)) return;
    const sprites = RESOURCES.biopulp.sprites;
    const key = sprites[(Math.random() * sprites.length) | 0];
    const img = this.add.image(tx * TILE + TILE * 0.5, ty * TILE + TILE * 0.5, key);
    img.setOrigin(0.5, 0.5);
    img.setScale(TILE * (1.5 + Math.random() * 1.0) / Math.max(img.width, img.height));
    img.setDepth(ty * TILE + TILE);
    this._addDeposit('biopulp', tx, ty, img);
  }

  // ── decorations (docs/adr/0009) ─────────────────────────────────────────────

  // Scatter every Decoration type from the data table; each registers its Footprint in the
  // occupancy layer so nothing overlaps and blocking types make their Tiles unwalkable.
  _placeDecorations() {
    const r = mkRNG(999);
    for (const def of Object.values(DECORATIONS)) this._scatterDecoration(def, r);
  }

  _scatterDecoration(def, r) {
    if (def.clustered) {
      const clusters = Math.ceil(def.count / 5);
      for (let c = 0; c < clusters; c++) {
        const cx = (r() * (MAP_W - 6) + 3) | 0;
        const cy = (r() * (MAP_H - 6) + 3) | 0;
        const n = 3 + ((r() * 4) | 0);
        for (let k = 0; k < n; k++)
          this._tryPlaceDecoration(def, cx + ((r() * 7 - 3) | 0), cy + ((r() * 7 - 3) | 0), r);
      }
    } else {
      for (let i = 0; i < def.count; i++)
        this._tryPlaceDecoration(def, (r() * (MAP_W - 2) + 1) | 0, (r() * (MAP_H - 2) + 1) | 0, r);
    }
  }

  // Best-effort: place one Decoration of `def` at (tx,ty) if its Footprint is free, else skip.
  _tryPlaceDecoration(def, tx, ty, r) {
    if (!this._footprintFree(tx, ty, def.w, def.h)) return;
    const key = def.sprites[(r() * def.sprites.length) | 0];
    const px = (tx + def.w * 0.5) * TILE;
    const py = (ty + def.h) * TILE; // base at the Footprint's bottom edge
    const img = this.add.image(px, py, key);
    img.setOrigin(0.5, def.originY);
    const [lo, hi] = def.scale;
    img.setScale(def.w * TILE * (lo + r() * (hi - lo)) / Math.max(img.width, img.height));
    img.setDepth(py);
    this._occupy(tx, ty, def.w, def.h, `deco:${def.id}`, def.blocking);
  }

  // ── deposits & gathering (docs/adr/0008) ────────────────────────────────────

  _addDeposit(type, tx, ty, sprite) {
    const def = getResource(type);
    const deposit = { type, tx, ty, amount: def ? def.depositAmount : 0, max: def ? def.depositAmount : 0, sprite };
    // Amount-left bar (always visible, distinct from the Runner Health bar). Deposits never move,
    // so it's drawn once here and only redrawn in _collect when the amount changes — never per-frame.
    deposit._amountBar = this.add.graphics();
    this._deposits.push(deposit);
    this._depositByTile.set(`${tx},${ty}`, deposit);
    this._occupy(tx, ty, 1, 1, 'deposit', true); // Deposits block their Tile (docs/adr/0009)
    this._drawDepositBar(deposit);
    return deposit;
  }

  // Draw a Deposit's amount-left bar: a fixed-width track anchored above its Tile (not the
  // variably-scaled sprite), so a dense cluster shows an even, readable row. Cyan fill reads as
  // "resource remaining" — kept separate from the red Runner Health bar (CONTEXT.md, ADR-0008).
  // Hidden while full to keep dense fields uncluttered; appears once gathering begins.
  _drawDepositBar(deposit) {
    const g = deposit._amountBar;
    if (!g) return;
    const frac = deposit.max > 0 ? deposit.amount / deposit.max : 0;
    if (frac >= 1) { g.setVisible(false); return; }
    const w = TILE * 0.9;
    const h = 4;
    const cx = deposit.tx * TILE + TILE * 0.5;
    const x = cx - w / 2;
    const y = deposit.ty * TILE - 12; // a little above the Tile's top edge
    g.clear();
    g.fillStyle(0x06222b, 1).fillRect(x, y, w, h);
    g.fillStyle(0x35d6e6, 1).fillRect(x, y, w * frac, h);
    g.setDepth(2e6).setVisible(true);
  }

  // The Tile a Unit currently stands on (feet at the Tile's bottom-centre — matches movement.js).
  _unitTile(unit) {
    return { x: Math.floor(unit.x / TILE), y: Math.floor((unit.y - TILE * 0.5) / TILE) };
  }

  // World primitive: claim the nearest unclaimed Deposit within CLAIM_RADIUS of where the Worker
  // was rallied, and return an opaque handle + a free Tile to stand on beside it + its gather time
  // (docs/adr/0017). At most one Worker holds a Deposit at a time, so several Workers on one shared
  // Flow spread across the cluster instead of crowding one. null ⇒ nothing free in reach: the
  // Gather executor then holds the cursor and the Worker waits in place until a Claim frees.
  _claimDeposit(unit) {
    const { x: ux, y: uy } = this._unitTile(unit);
    let best = null, bestStand = null, bestD = Infinity;
    for (const dep of this._deposits) {
      if (dep.claimedBy && dep.claimedBy !== unit) continue;      // held by another Worker
      if (this._cargoRoom(unit, dep.type) <= 0) continue;         // can't carry any more of this
      const ddx = dep.tx - ux, ddy = dep.ty - uy;
      if (Math.max(Math.abs(ddx), Math.abs(ddy)) > CLAIM_RADIUS) continue; // out of rally reach
      const d = ddx * ddx + ddy * ddy;
      if (d >= bestD) continue;
      const stand = this._standingTileBeside(dep, ux, uy);
      if (!stand) continue;                                       // hemmed in — ungatherable
      best = dep; bestStand = stand; bestD = d;
    }
    if (!best) return null;
    this._releaseClaim(unit);     // drop any prior hold before taking a new one
    best.claimedBy = unit;
    unit._claim = best;
    const def = getResource(best.type);
    return { handle: best, dest: bestStand, gatherTime: def ? def.gatherTime : 0 };
  }

  // A free Tile 8-adjacent to a Deposit (Walkable, so not the Deposit's own blocked Tile), nearest
  // to (fromX,fromY) — where the Worker stands to gather. null when the Deposit is fully hemmed in.
  _standingTileBeside(dep, fromX, fromY) {
    let best = null, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const tx = dep.tx + dx, ty = dep.ty + dy;
        if (!this.walkable(tx, ty)) continue;
        const d = (tx - fromX) ** 2 + (ty - fromY) ** 2;
        if (d < bestD) { best = { x: tx, y: ty }; bestD = d; }
      }
    return best;
  }

  // Release a Worker's Claim on its Deposit so the next Worker can take it (docs/adr/0017).
  // Idempotent. Called when Cargo fills, the Deposit empties, or the Worker is re-assigned/destroyed.
  _releaseClaim(unit) {
    const dep = unit && unit._claim;
    if (!dep) return;
    if (dep.claimedBy === unit) dep.claimedBy = null;
    unit._claim = null;
  }

  // How much more of `type` this Unit can carry, given its Cargo (single slot) and capacity.
  _cargoRoom(unit, type) {
    const held = unit.cargo && unit.cargo.type === type ? unit.cargo.amount : 0;
    return (unit.carryCapacity ?? UNIT_CARRY_CAPACITY) - held;
  }

  // World primitive: take one yield from the Deposit into the Unit's Cargo, deplete it, and
  // remove the Deposit (freeing its Tile) once empty.
  _collect(unit, deposit) {
    const def = getResource(deposit.type);
    if (!def || deposit.amount <= 0) return;
    const got = Math.min(def.yield, deposit.amount, this._cargoRoom(unit, deposit.type));
    if (got <= 0) return; // Cargo full
    deposit.amount -= got;
    if (unit.cargo && unit.cargo.type === deposit.type) unit.cargo.amount += got;
    else unit.cargo = { type: deposit.type, amount: got };
    if (deposit.amount <= 0) this._removeDeposit(deposit); // frees this Worker's Claim too
    else this._drawDepositBar(deposit); // redraw the amount-left bar on change
    // Cargo full ⇒ leaving to deliver: release the Claim so a waiting Worker can take this
    // Deposit (docs/adr/0017). (When the Deposit emptied, _removeDeposit already freed it.)
    if (this._cargoRoom(unit, deposit.type) <= 0) this._releaseClaim(unit);
    this._refreshUnitLabel(unit);
  }

  _removeDeposit(deposit) {
    if (deposit.claimedBy) this._releaseClaim(deposit.claimedBy); // free its Claim (docs/adr/0017)
    deposit.sprite.destroy();
    deposit._amountBar?.destroy();
    this._depositByTile.delete(`${deposit.tx},${deposit.ty}`);
    this._occupied.delete(`${deposit.tx},${deposit.ty}`); // free the Tile (docs/adr/0009)
    this._deposits = this._deposits.filter((d) => d !== deposit);
  }

  // World primitive: if the Worker is beside the Command Center and carrying Cargo, move it all
  // into the player's Stockpile and empty the Cargo (docs/adr/0008). No-op otherwise.
  _deliver(unit) {
    if (!unit.cargo || !this._adjacentToCommandCenter(unit)) return;
    // Turn to face the Command Center as the Worker hands off its Cargo.
    const cc = this._commandCenter;
    if (cc) unit.facePoint?.((cc.tx + cc.tileW / 2) * TILE, (cc.ty + cc.tileH / 2) * TILE);
    const { type, amount } = unit.cargo;
    this._stockpile[type] = (this._stockpile[type] || 0) + amount;
    unit.cargo = null;
    this._refreshUnitLabel(unit);
    this._updateMaterialsPanel();
  }

  // World primitive: how long delivering takes for this Worker, in ms (docs/adr/0008). 0 when
  // there is nothing to hand off (no Cargo, or not beside the Command Center), so the Deliver
  // Action no-ops instantly. Also turns the Worker to face the Command Center as the hand-off
  // begins, so it stays facing it for the whole delivery (it is stationary meanwhile).
  _deliverDuration(unit) {
    if (!unit.cargo || !this._adjacentToCommandCenter(unit)) return 0;
    const cc = this._commandCenter;
    if (cc) unit.facePoint?.((cc.tx + cc.tileW / 2) * TILE, (cc.ty + cc.tileH / 2) * TILE);
    const def = getResource(unit.cargo.type);
    return (def?.deliverTime || 0) * 1000;
  }

  // True if the Unit is within DELIVER_RANGE Tiles of the Command Center's Footprint (Chebyshev
  // distance to the footprint rectangle). Forgiving, because the blocking footprint + steering
  // leave a Unit settled a Tile or two short of actually touching the building.
  _adjacentToCommandCenter(unit) {
    const cc = this._commandCenter;
    if (!cc) return false;
    const { x: ux, y: uy } = this._unitTile(unit);
    const dx = Math.max(cc.tx - ux, ux - (cc.tx + cc.tileW - 1), 0);
    const dy = Math.max(cc.ty - uy, uy - (cc.ty + cc.tileH - 1), 0);
    return Math.max(dx, dy) <= DELIVER_RANGE;
  }

  // Pure spatial test: is any Deposit on a Tile 8-adjacent to the Unit? (Unlike _claimDeposit,
  // ignores Claims and whether Cargo is full — a Condition only reports state.)
  _hasAdjacentDeposit(unit) {
    const { x: ux, y: uy } = this._unitTile(unit);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if ((dx || dy) && this._depositByTile.has(`${ux + dx},${uy + dy}`)) return true;
    return false;
  }

  // World primitive: evaluate a Branch's Condition against Unit/game state (docs/adr/0010).
  // `params` is the Branch's stored { condition, ...args }. Unknown/unset ⇒ false (No path).
  _testCondition(unit, params) {
    switch (params && params.condition) {
      case 'cargo_full':        return !!unit.cargo && this._cargoRoom(unit, unit.cargo.type) <= 0;
      case 'cargo_empty':       return !unit.cargo || unit.cargo.amount <= 0;
      case 'deposit_adjacent':  return this._hasAdjacentDeposit(unit);
      case 'at_command_center': return this._adjacentToCommandCenter(unit);
      case 'stockpile_gte':     return (this._stockpile.alloys || 0) >= (params.amount || 0);
      case 'enemy_in_range':    return this._enemyWithin(unit, getUnitType(unit.type)?.range || 0);
      case 'enemy_nearby':      return this._enemyWithin(unit, params.amount || params.radius || 0);
      default:                  return false;
    }
  }

  // True if any opposing-Faction Runner is within `tiles` Tiles of the Unit (edge distance,
  // accounting for the target's footprint radius) — backs the combat Conditions (docs/adr/0012).
  _enemyWithin(unit, tiles) {
    const reach = tiles * TILE;
    for (const t of this._targetsFor(unit))
      if (Math.hypot(unit.x - t.x, unit.y - t.y) - t.radius <= reach) return true;
    return false;
  }

  // ── buildings ─────────────────────────────────────────────────────────────

  _spawnBuildings() {
    const cx = (MAP_W / 2) | 0;
    const cy = (MAP_H / 2) | 0;

    const place = (BuildingClass, tx, ty, w, h, label) => {
      const b = new BuildingClass(this, tx, ty);
      this._reserveClearance(tx, ty, w, h, START_CLEARANCE);
      this._occupy(tx, ty, w, h, 'building', true);
      this._registerBuilding(b, label);
      return b;
    };

    // command center at map center
    const tx = cx - 3, ty = cy - 3;
    this._commandCenter = place(CommandCenter, tx, ty, 6, 6, 'Command Center');

    // barracks 2 tiles to the right of command center
    this._barracks = place(Barracks, tx + 8, ty, 6, 6, 'Barracks');

    // factory 2 tiles to the left of command center
    this._factory = place(Factory, tx - 8, ty, 6, 6, 'Factory');
  }

  // Make a Building a Runner (CONTEXT.md): selectable, with a restored Assignment and a Run, plus
  // a label above it showing its assigned Flow. Buildings are ticked alongside Units.
  _registerBuilding(b, label, presetFlowId = null) {
    b.label = `${label} ${this._nextUnitId++}`;
    // A freshly-built Building carries the Flow its Build node chose (docs/adr/0018); a pre-placed
    // one restores its saved Assignment by label (matching _saveAssignments / see _registerUnit).
    const savedId = presetFlowId ?? this._assignments[b.label];
    b.assignedFlowId = savedId && flowLibrary.get(savedId) ? savedId : null;
    b.sprite.setInteractive({ useHandCursor: true });
    b.sprite.setData('building', b);
    const ui = this._createRunnerUI(b.tileW * TILE * 0.7);
    this._uiOverlay.appendChild(ui.el);
    b._ui = ui;
    this.buildings.push(b);
    this._refreshBuildingLabel(b);
    this._startRun(b);
  }

  _refreshBuildingLabel(b) {
    if (!b._ui) return;
    const entry = b.assignedFlowId ? flowLibrary.get(b.assignedFlowId) : null;
    b._ui.nameEl.textContent = b.label;
    b._ui.flowEl.textContent = entry ? entry.name : '';
    b._ui.flowEl.style.display = entry ? '' : 'none';
  }

  // ── units ─────────────────────────────────────────────────────────────────

  _spawnUnits() {
    this.units = [];
    const cc  = this._commandCenter;
    const bar = this._barracks;
    const fac = this._factory;
    // workers below CC; marines right of barracks; mechs left of factory
    const unitSpawns = [
      { tx: cc.tx - 1,                    ty: cc.ty + cc.tileH + 3,        label: 'Worker',       Cls: Worker,      dir: 'S'  },
      { tx: cc.tx + (cc.tileW / 2 | 0),   ty: cc.ty + cc.tileH + 3,        label: 'Worker',       Cls: Worker,      dir: 'SE' },
      { tx: cc.tx + cc.tileW + 1,         ty: cc.ty + cc.tileH + 3,        label: 'Worker',       Cls: Worker,      dir: 'NW' },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty,                       label: 'Marine',       Cls: Marine,      dir: 'W'  },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty + (bar.tileH / 2 | 0), label: 'Marine',       Cls: Marine,      dir: 'SW' },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty + bar.tileH,           label: 'Marine',       Cls: Marine,      dir: 'NW' },
      { tx: fac.tx,                        ty: fac.ty + fac.tileH + 2,       label: 'Mech',         Cls: Mech,        dir: 'N'  },
      { tx: fac.tx + fac.tileW,           ty: fac.ty + fac.tileH + 2,       label: 'Mech',         Cls: Mech,        dir: 'NE' },
      { tx: fac.tx + (fac.tileW / 2 | 0), ty: fac.ty + fac.tileH + 4,       label: 'Tank',         Cls: Tank,        dir: 'N'  },
      { tx: bar.tx - 3,                   ty: bar.ty,                        label: 'Zapper',       Cls: Zapper,      dir: 'E'  },
      { tx: bar.tx - 3,                   ty: bar.ty + bar.tileH,            label: 'Zapper',       Cls: Zapper,      dir: 'SE' },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty - 3,                    label: 'Reaper',       Cls: Reaper,      dir: 'S'  },
      { tx: bar.tx + bar.tileW + 4,       ty: bar.ty - 3,                    label: 'Reaper',       Cls: Reaper,      dir: 'SW' },
    ];
    // 30 biters in a staggered grid across the whole map, placed away from the base
    const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const biterSpawns = Array.from({ length: 30 }, (_, i) => ({
      tx: 8 + (i % 6) * 18 + (Math.floor(i / 6) % 2) * 7,
      ty: 6 + Math.floor(i / 6) * 16,
      label: 'Biter',
      dir: DIRS8[i % 8],
    }));
    const allSpawns = [
      ...unitSpawns.map(s => ({ ...s, critter: false })),
      ...biterSpawns.map(s => ({ ...s, Cls: Biter, critter: true })),
    ];
    for (const { tx: targetX, ty: targetY, label, Cls, dir, critter } of allSpawns) {
      for (let r = 0; r <= 10; r++) {
        let placed = false;
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const tx = targetX + dx, ty = targetY + dy;
            const nearBase = critter && this._commandCenter && (() => {
              const bcc = this._commandCenter;
              return Math.hypot(tx - (bcc.tx + bcc.tileW * 0.5), ty - (bcc.ty + bcc.tileH * 0.5)) < 28;
            })();
            if (this.walkable(tx, ty) && !this._isHill(tx, ty - 1) && !nearBase) {
              const unit = new Cls(this, tx * TILE + TILE * 0.5, ty * TILE + TILE);
              this._registerUnit(unit, label);
              if (critter) {
                unit.assignedFlowId = this._critterFlowId;
                this._refreshUnitLabel(unit);
              }
              unit.setDirection(dir);
              placed = true;
            }
          }
        }
        if (placed) break;
      }
    }
  }

  // Make a Unit selectable and give it a Flow-name label above its sprite. (Carry capacity now
  // comes from the unit type in the data table, set in the Unit constructor.)
  _registerUnit(unit, label) {
    unit.label = `${label} ${this._nextUnitId++}`;
    // Restore a persisted assignment, but only if that Flow still exists in the Library. Keyed by
    // the full label (e.g. "Marine 5") — the same key _saveAssignments writes; spawn order is
    // deterministic, so a given label maps to the same Unit across refreshes.
    const savedId = this._assignments[unit.label];
    unit.assignedFlowId = savedId && flowLibrary.get(savedId) ? savedId : null;
    unit.sprite.setInteractive({ useHandCursor: true });
    unit.sprite.setData('unit', unit);

    const ui = this._createRunnerUI(unit._displaySize * 0.8);
    this._uiOverlay.appendChild(ui.el);
    unit._ui = ui;

    this.units.push(unit);
    this._refreshUnitLabel(unit);
    unit.syncShadow();
    this._startRun(unit);
  }

  // Label above a Unit: its Flow name plus a Cargo readout (e.g. "Worker 1  ·  ◆20") so
  // gathering is observable until there's a real animation/HUD (docs/adr/0008).
  _refreshUnitLabel(unit) {
    if (!unit._ui) return;
    const entry = unit.assignedFlowId ? flowLibrary.get(unit.assignedFlowId) : null;
    const cargo = unit.cargo ? `  ·  ${(() => { const def = getResource(unit.cargo.type); return (def ? def.glyph : '') + unit.cargo.amount; })()}` : '';
    unit._ui.nameEl.textContent = `${unit.label}${cargo}`;
    unit._ui.flowEl.textContent = entry ? entry.name : '';
    unit._ui.flowEl.style.display = entry ? '' : 'none';
  }

  // (Re)start a Runner's Run from its assigned Flow's OnStart — Units and Buildings alike. Called
  // when a Runner is registered and when its Assignment changes; a fresh Assignment runs from the
  // top. A Run only exists while the simulation is running (docs/adr/0005): paused, or with no
  // Flow assigned, it is idle.
  _startRun(runner) {
    this._releaseClaim(runner); // a fresh Run drops any Deposit held under the old one (docs/adr/0017)
    this._releaseBuildSlot(runner); // …and any build slot held under it (docs/adr/0018)
    const entry = this._running && runner.assignedFlowId ? flowLibrary.get(runner.assignedFlowId) : null;
    runner.run = entry ? startRun(entry.id, entry.model) : null;
    if (runner.run) this._log(`${runner.label} starts flow "${entry.name}"`);
  }

  // Timestamped console log for in-game events (combat, flow transitions, damage).
  _log(msg) {
    const s = (this.time.now / 1000).toFixed(1);
    console.log(`[${s}s] ${msg}`);
  }

  // Human-readable description of a node for log output, including key params.
  _nodeDesc(node) {
    const p = node.params;
    if (node.kind === 'Move' || node.kind === 'AttackMove') {
      const d = p?.destination;
      return d ? `${node.kind} → (${d.x}, ${d.y})` : node.kind;
    }
    if (node.kind === 'Wait') return p?.duration ? `Wait ${p.duration}s` : 'Wait';
    if (node.kind === 'Hold') return p?.duration ? `Hold ${p.duration}s` : 'Hold';
    if (node.kind === 'Train') return p?.type ? `Train ${p.type}` : 'Train';
    if (node.kind === 'Build') return p?.buildingType ? `Build ${p.buildingType}` : 'Build';
    return node.kind;
  }

  // START/PAUSE (docs/adr/0005). PAUSE only flips the flag — update() then freezes, so every
  // Run keeps its cursor and every Runner keeps its position. START resumes those frozen Runs and
  // starts any assigned Runner that has no Run yet (firing OnStart), so the very first START
  // launches the Flows and later ones continue rather than restart.
  _setRunning(running) {
    if (this._over) return; // level decided — START/PAUSE is inert
    this._running = running;
    if (running) for (const r of this._runners()) if (!r.run) this._startRun(r);
    else this._stopInspecting(); // pausing returns to the authoring/assign gesture
    this._updateStartBtn();
  }

  _buildStartButton() {
    const btn = document.createElement('button');
    btn.className = 'sim-toggle';
    btn.addEventListener('click', () => this._setRunning(!this._running));
    document.body.appendChild(btn);
    this._startBtn = btn;
    this._updateStartBtn();
  }

  _updateStartBtn() {
    if (!this._startBtn) return;
    this._startBtn.textContent = this._running ? '❚❚ Pause' : '▶ Start';
    this._startBtn.classList.toggle('running', this._running);
  }

  // ── live inspector ──────────────────────────────────────────────────────────

  // The shared Flow editor instance (set on the game registry in main.js), or null pre-mount.
  _editor() { return this.registry.get('flowEditor') || null; }

  // Open the editor as a live read-only inspector of `runner`'s Flow, docked beside the still-live
  // map. The Run may not exist yet (just-assigned) — fall back to the Assignment so the Flow still
  // shows. Closing the panel (its ✕) clears the selection so the per-frame sync stops.
  _inspectRunner(runner) {
    const editor = this._editor();
    if (!editor) return;
    const flowId = runner.run?.flowId ?? runner.assignedFlowId ?? null;
    const model = this._resolveFlow(flowId);
    if (!model) return; // no Flow to show (unassigned) — leave the current selection/panel as-is
    this._selectedRunner = runner;
    this._inspectFlowId = flowId;
    editor.inspect(model, this._inspectTitle(runner), {
      readOnly: true,
      onClose: () => this._stopInspecting(),
    });
    editor.show();
  }

  _stopInspecting() {
    this._selectedRunner = null;
    this._inspectFlowId = null;
    this._editor()?.stopInspecting();
  }

  _inspectTitle(runner) {
    return `${runner.label || 'Runner'}  ·  ${runner.faction}`;
  }

  // Per-frame: keep the editor's highlight on the inspected Runner's current node, swapping the
  // shown Flow if its Assignment changed (e.g. a re-assign restarted the Run on a new Flow).
  _syncInspector() {
    if (!this._selectedRunner) return;
    const editor = this._editor();
    if (!editor) return;
    const r = this._selectedRunner;
    const flowId = r.run?.flowId ?? r.assignedFlowId ?? null;
    if (flowId !== this._inspectFlowId) {
      this._inspectFlowId = flowId;
      const model = this._resolveFlow(flowId);
      if (model) {
        editor.inspect(model, this._inspectTitle(r), {
          readOnly: true,
          onClose: () => this._stopInspecting(),
        });
      }
    }
    editor.setActiveNode(r.run?.current ?? null, r.run?.status ?? 'idle', this._runDetail(r));
  }

  // A human-readable status line for the inspected Runner's Run: the active node's title plus its
  // elapsed/duration for timed nodes (Wait/Gather/Hold/Train all accumulate `elapsed` in scratch).
  _runDetail(r) {
    const run = r.run;
    if (!run) return 'idle — paused or no Flow assigned';
    if (run.status === 'halted') return 'halted — current node was removed by an edit';
    if (run.status === 'idle') return 'idle — Flow finished';
    // Armed but no active Frame: the base line ended and the Run is waiting to service its next
    // Interrupt (docs/adr/0019). Still 'running', just nothing on the cursor right now.
    if (run.current == null) return 'waiting for an interrupt';
    const node = this._resolveFlow(run.flowId)?.getNode(run.current);
    if (!node) return run.status;
    let title;
    try { title = getNodeKind(node.kind).title; } catch { title = node.kind; }
    const ms = run.state?.elapsed;
    if (ms != null) {
      // Prefer the live scratch duration (Gather/Deliver), else the node's duration Param (Wait/Hold).
      const total = run.state?.duration != null ? run.state.duration / 1000 : node.params?.duration;
      return total ? `▶ ${title}  ${(ms / 1000).toFixed(1)} / ${total.toFixed(1)}s`
                   : `▶ ${title}  ${(ms / 1000).toFixed(1)}s`;
    }
    return `▶ ${title}`;
  }

  // Top-left panel showing the player's Stockpile — one entry per known Resource.
  _buildMaterialsPanel() {
    const panel = document.createElement('div');
    panel.className = 'materials-panel';
    document.body.appendChild(panel);
    this._materialsPanel = panel;
    this._updateMaterialsPanel();
  }

  _updateMaterialsPanel() {
    if (!this._materialsPanel) return;
    this._materialsPanel.textContent = Object.values(RESOURCES)
      .map((def) => `${def.glyph} ${this._stockpile[def.id] || 0}`)
      .join('     ');
  }

  // Centre banner for the Objective outcome (docs/adr/0014) — hidden until win/lose.
  _buildBanner() {
    const b = document.createElement('div');
    b.className = 'level-banner hidden';
    document.body.appendChild(b);
    this._banner = b;
  }

  _showBanner(text, won) {
    if (!this._banner) return;
    this._banner.textContent = text;
    this._banner.classList.toggle('win', won);
    this._banner.classList.toggle('lose', !won);
    this._banner.classList.remove('hidden');
  }

  // Sync a Unit's sprite + DOM label to its logical {x,y} (feet position), keeping depth = y so
  // it sorts correctly against trees/alloys/other Units.
  _placeUnit(unit, cam, camOX, camOY) {
    if (unit._vel) unit.updateDirection(unit._vel.x, unit._vel.y);
    unit.sprite.setPosition(unit.x, unit.y);
    unit.sprite.setDepth(unit.y);
    unit.syncShadow();
    this._drawUnitProgress(unit);
    if (unit._progressBar) unit._progressBar.setScale(1 / cam.zoom);
    if (unit._ui) {
      const hbTopY = unit.y - unit._displaySize - 6;
      const sx = (unit.x - cam.scrollX) * cam.zoom + camOX;
      const sy = (hbTopY - cam.scrollY) * cam.zoom + camOY;
      unit._ui.el.style.left = sx + 'px';
      unit._ui.el.style.top = sy + 'px';
      if (unit.health > 0) {
        unit._ui.hbBg.style.display = '';
        unit._ui.hbFill.style.width = (unit.health / unit.maxHealth * 100) + '%';
      } else {
        unit._ui.hbBg.style.display = 'none';
      }
    }
  }

  // Draw a Worker's action progress bar above its head while it runs a timed Action — green for
  // Gather, gold for Deliver (docs/adr/0008). Read straight from the Run's live scratch state
  // (elapsed/duration set by the executors), so it tracks the interpreter exactly; hidden the
  // rest of the time. Kept distinct from the Deposit's cyan amount-left bar and the red Health bar.
  _drawUnitProgress(unit) {
    let frac = -1, color = 0x46e08a;
    const run = unit.run;
    if (run && run.status === 'running') {
      const node = this._resolveFlow(run.flowId)?.getNode(run.current);
      const st = run.state;
      if (node && st && st.duration > 0) {
        if (node.kind === 'Gather') { frac = st.elapsed / st.duration; color = 0x46e08a; }
        else if (node.kind === 'Deliver') { frac = st.elapsed / st.duration; color = 0xffd23f; }
      }
    }
    if (frac < 0) { unit._progressBar?.setVisible(false); return; }
    const g = unit._progressBar || (unit._progressBar = this.add.graphics());
    frac = Math.max(0, Math.min(1, frac));
    const w = unit._displaySize * 0.8, h = 5;
    const x = unit.x - w / 2;
    const y = unit.y - unit._displaySize - 14; // above the Health-bar slot
    g.clear();
    g.fillStyle(0x12100a, 1).fillRect(x, y, w, h);
    g.fillStyle(color, 1).fillRect(x, y, w * frac, h);
    g.setDepth(2e6).setVisible(true);
  }

  // Draw a Building's production progress bar above it while a Train Action is building a Unit
  // (docs/adr/0013) — blue, filling over the Unit type's buildTime. Read from the Run's live
  // scratch state (started/elapsed/duration set by _train), so it appears only once production is
  // funded and under way, not while the Train is still blocked waiting to afford the cost.
  _drawBuildingProgress(building) {
    let frac = -1;
    const run = building.run;
    if (run && run.status === 'running') {
      const node = this._resolveFlow(run.flowId)?.getNode(run.current);
      const st = run.state;
      if (node && node.kind === 'Train' && st && st.started && st.duration > 0) {
        frac = st.elapsed / st.duration;
      }
    }
    if (frac < 0) { building._progressBar?.setVisible(false); return; }
    const g = building._progressBar || (building._progressBar = this.add.graphics());
    frac = Math.max(0, Math.min(1, frac));
    const w = building.tileW * TILE * 0.7, h = 6;
    const x = building._cx - w / 2;
    const y = building.sprite.y - building.sprite.displayHeight - 16; // just above the Health bar
    g.clear();
    g.fillStyle(0x0a1626, 1).fillRect(x, y, w, h);
    g.fillStyle(0x4aa3ff, 1).fillRect(x, y, w * frac, h);
    g.setDepth(2e6).setVisible(true);
  }

  // ── assignment persistence ─────────────────────────────────────────────────

  _loadAssignments() {
    try { return JSON.parse(localStorage.getItem(ASSIGN_KEY)) || {}; }
    catch { return {}; }
  }

  _saveAssignments() {
    const map = {};
    for (const r of this._runners())
      if (r.assignedFlowId && r.faction === FACTION.PLAYER) map[r.label] = r.assignedFlowId;
    try { localStorage.setItem(ASSIGN_KEY, JSON.stringify(map)); } catch { /* quota/full */ }
  }

  // ── camera ────────────────────────────────────────────────────────────────

  _setupCamera() {
    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_W * TILE, MAP_H * TILE);
    cam.setScroll(
      (MAP_W * TILE - cam.width)  * 0.5,
      (MAP_H * TILE - cam.height) * 0.5
    );

    // The Flow editor is a DOM overlay (docs/adr/0001). While it's open, disable all map pointer
    // input — Phaser's window-level listeners would otherwise let clicks fall through the overlay
    // onto Units/Buildings behind it. The editor emits this event from _applyVisibility.
    // The full-screen editor blocks map input; the docked inspector (blocking:false) does not, so
    // the map stays clickable to switch which Runner is inspected (docs/adr/0001).
    window.addEventListener('flow-editor-visibility',
      (e) => { this.input.enabled = !(e.detail.open && e.detail.blocking); });

    let drag = null;
    // Tracked separately from `drag` so it survives pointerup (which clears `drag`) and is
    // still readable when gameobjectup fires — order between the two isn't guaranteed.
    this._dragMoved = false;

    this.input.on('pointerdown', (p, over) => {
      this._dragMoved = false;
      if (this._pick) {
        if (p.rightButtonDown()) { this._cancelPick(); return; } // right-click cancels
        // In pick mode a click picks and a drag pans — start tracking either way.
        drag = { ox: p.x, oy: p.y, sx: cam.scrollX, sy: cam.scrollY };
        return;
      }
      // Track a potential drag even when pressing on a Runner, so panning works no matter where
      // the gesture starts. A clean click still selects it (gameobjectup bails once _dragMoved).
      drag = { ox: p.x, oy: p.y, sx: cam.scrollX, sy: cam.scrollY };
      this.game.canvas.style.cursor = 'grabbing';
    });
    this.input.on('pointermove', p => {
      if (this._pick) {
        const { tx, ty } = this._pointerTile(p);
        this._updatePickHighlight(tx, ty);
      }
      if (!drag) return;
      if (Math.abs(p.x - drag.ox) + Math.abs(p.y - drag.oy) > 3) this._dragMoved = true;
      cam.setScroll(drag.sx - (p.x - drag.ox), drag.sy - (p.y - drag.oy));
      // clamp immediately so update() reads the real scroll before preRender() runs (docs/adr/0001)
      if (cam.useBounds) { cam.scrollX = cam.clampX(cam.scrollX); cam.scrollY = cam.clampY(cam.scrollY); }
    });
    const endDrag = () => {
      // A click (no drag) in pick mode commits the hovered Tile.
      if (this._pick && !this._dragMoved) this._commitPick();
      drag = null;
      this.game.canvas.style.cursor = this._pick ? 'crosshair' : 'grab';
    };
    this.input.on('pointerup', endDrag);
    this.input.on('pointerupoutside', endDrag);

    // The assign-Flow modal is also a DOM overlay over the canvas: disable map input while it's
    // open so clicks on a flow row don't fall through to the Runner behind it (docs/adr/0001).
    // The overlay opens during gameobjectup (a pointerup), so the matching endDrag never runs —
    // clear the dangling drag here, or the map would pan on mouse-move after the overlay closes.
    window.addEventListener('assign-overlay-visibility', (e) => {
      this.input.enabled = !e.detail.open;
      if (e.detail.open) { drag = null; this._dragMoved = false; }
      this.game.canvas.style.cursor = this._pick ? 'crosshair' : 'grab';
    });

    // Click a Runner → open the assign-flow overlay, filtered to that Runner's kind (docs/adr/
    // 0015). Ignore while picking or after a drag. A Unit picks Unit-Flows; a Building, Building-
    // Flows. Enemy Units are not the player's to command.
    this.input.on('gameobjectup', (_p, obj) => {
      if (this._pick || this._dragMoved) return;
      // While running, a click inspects the Runner's live Flow (either Faction); while paused it
      // assigns a Flow (player Runners only). The docked inspector leaves the map clickable, so a
      // click on another Runner just switches who is inspected.
      if (this._running) {
        const runner = (obj.getData && (obj.getData('unit') || obj.getData('building'))) || null;
        if (runner) this._inspectRunner(runner);
        return;
      }
      const unit = obj.getData && obj.getData('unit');
      if (unit && unit.faction === FACTION.PLAYER) {
        openAssignOverlay(unit, flowLibrary, 'unit', (u) => {
          this._refreshUnitLabel(u);
          this._saveAssignments();
          this._startRun(u); // always-live: new Assignment runs at once; re-assign restarts
        });
        return;
      }
      const building = obj.getData && obj.getData('building');
      if (building && building.faction === FACTION.PLAYER) {
        openAssignOverlay(building, flowLibrary, 'building', (b) => {
          this._refreshBuildingLabel(b);
          this._saveAssignments();
          this._startRun(b);
        }, building.type);
      }
    });

    this.input.on('wheel', (_p, _objs, _dx, deltaY) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - deltaY * 0.001, 0.25, 2));
    });

    this.game.canvas.style.cursor = 'grab';
  }

  // ── position picking ────────────────────────────────────────────────────────

  _pointerTile(p) {
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    return { tx: Math.floor(wp.x / TILE), ty: Math.floor(wp.y / TILE) };
  }

  // Enter pick mode: highlight the hovered Tile (green if Walkable, red if not). A click
  // on a Walkable Tile commits; right-click/Esc cancels (wired via the camera handlers).
  _beginPositionPick({ onPicked, onCancel, footprint = null }) {
    if (this._pick) this._endPick();
    const gfx = this.add.graphics().setDepth(2e6);
    // window-level so Esc works even though the pick starts from a DOM button (the Phaser
    // canvas may not have keyboard focus yet).
    const escHandler = (e) => { if (e.key === 'Escape') this._cancelPick(); };
    window.addEventListener('keydown', escHandler);
    this._pick = {
      onPicked, onCancel, gfx, tile: null,
      footprint: footprint && footprint.w > 0 ? footprint : { w: 1, h: 1 }, // Build picks a Footprint (docs/adr/0018)
      escOff: () => window.removeEventListener('keydown', escHandler),
    };
    const { tx, ty } = this._pointerTile(this.input.activePointer);
    this._updatePickHighlight(tx, ty);
    this.game.canvas.style.cursor = 'crosshair';
  }

  _updatePickHighlight(tx, ty) {
    if (!this._pick) return;
    const { w, h } = this._pick.footprint;
    // A 1×1 pick needs only a Walkable Tile; a Footprint pick (Build) needs the whole area buildable
    // — non-blocking occupants like ground decor are allowed, only blocking ones reject (docs/adr/0018).
    const ok = (w === 1 && h === 1) ? this.walkable(tx, ty) : this._footprintBuildable(tx, ty, w, h);
    const g = this._pick.gfx;
    g.clear();
    g.fillStyle(ok ? 0x33dd55 : 0xdd3333, 0.35);
    g.lineStyle(2, ok ? 0x66ff88 : 0xff6666, 0.9);
    g.fillRect(tx * TILE, ty * TILE, w * TILE, h * TILE);
    g.strokeRect(tx * TILE, ty * TILE, w * TILE, h * TILE);
    this._pick.tile = { x: tx, y: ty, ok };
  }

  _commitPick() {
    const t = this._pick && this._pick.tile;
    if (!t || !t.ok) return; // ignore non-Walkable / off-map clicks; stay in pick mode
    const onPicked = this._pick.onPicked;
    this._endPick();
    onPicked && onPicked({ x: t.x, y: t.y });
  }

  _cancelPick() {
    const onCancel = this._pick && this._pick.onCancel;
    this._endPick();
    onCancel && onCancel();
  }

  _endPick() {
    if (!this._pick) return;
    this._pick.gfx.destroy();
    this._pick.escOff();
    this._pick = null;
    this.game.canvas.style.cursor = 'grab';
  }
}
