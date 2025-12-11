// ==========================================
// 1. DATA
// ==========================================

// Status Effect Definitions
const StatusEffectDefinitions = {
    "Bleed": { 
        desc: "Takes damage based on roll difference when hit", 
        color: "text-red-600",
        icon: "🩸",
        stackable: true,
        maxStacks: 5
    },
    "Poison": { 
        desc: "Takes damage at turn start, decreases each turn", 
        color: "text-green-500",
        icon: "☠️",
        stackable: true,
        maxStacks: 10
    },
    "Rupture": { 
        desc: "Every N damage taken triggers X bonus damage", 
        color: "text-purple-500",
        icon: "💥",
        stackable: true,
        maxStacks: 3
    },
    "Burn": { 
        desc: "Takes fire damage at turn end", 
        color: "text-orange-500",
        icon: "🔥",
        stackable: true,
        maxStacks: 5
    },
    "Weaken": { 
        desc: "Deals reduced damage", 
        color: "text-slate-400",
        icon: "⬇️",
        stackable: true,
        maxStacks: 3
    },
    "Vulnerable": { 
        desc: "Takes increased damage", 
        color: "text-yellow-500",
        icon: "🎯",
        stackable: true,
        maxStacks: 3
    }
};

// Status Effect Functions
const StatusEffectFunctions = {
    // Bleed: Higher roll difference = more damage, stacks increase multiplier
    applyBleed: (targetId, stacks, rollDiff = 0) => {
        const target = GameState.units[targetId];
        if (!target || target.hp <= 0) return 0;
        // Base bleed damage is 1 + (rollDiff / 3), multiplied by stacks
        const bleedDmg = Math.floor((1 + Math.floor(rollDiff / 3)) * stacks);
        if (bleedDmg > 0) {
            target.hp = Math.max(0, target.hp - bleedDmg);
            spawnFloatText(targetId, `-${bleedDmg}`, 'text-red-600');
            log(`${target.name} bleeds for ${bleedDmg} damage!`, 'dmg');
            updateUI(targetId);
        }
        return bleedDmg;
    },
    
    // Poison: Damage at turn start, reduces by 1 stack each turn
    tickPoison: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Poison) return 0;
        const stacks = unit.statusEffects.Poison;
        const poisonDmg = stacks;
        if (poisonDmg > 0) {
            unit.hp = Math.max(0, unit.hp - poisonDmg);
            spawnFloatText(unitId, `-${poisonDmg}`, 'text-green-500');
            log(`${unit.name} takes ${poisonDmg} poison damage!`, 'dmg');
            updateUI(unitId);
            // Reduce stacks by 1
            unit.statusEffects.Poison = Math.max(0, stacks - 1);
            if (unit.statusEffects.Poison <= 0) delete unit.statusEffects.Poison;
            updateStatusBadges(unitId);
        }
        return poisonDmg;
    },
    
    // Rupture: Every N damage triggers X extra damage (N=5, X=2*stacks)
    checkRupture: (unitId, damageDealt) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Rupture) return 0;
        const stacks = unit.statusEffects.Rupture;
        // Track cumulative damage for rupture
        if (!unit.ruptureDamageAccum) unit.ruptureDamageAccum = 0;
        unit.ruptureDamageAccum += damageDealt;
        const threshold = 5;
        let totalRuptureDmg = 0;
        while (unit.ruptureDamageAccum >= threshold) {
            unit.ruptureDamageAccum -= threshold;
            const ruptureDmg = 2 * stacks;
            unit.hp = Math.max(0, unit.hp - ruptureDmg);
            totalRuptureDmg += ruptureDmg;
            spawnFloatText(unitId, `-${ruptureDmg}`, 'text-purple-500');
            log(`${unit.name} ruptures for ${ruptureDmg} damage!`, 'dmg');
        }
        if (totalRuptureDmg > 0) updateUI(unitId);
        return totalRuptureDmg;
    },
    
    // Burn: Damage at turn end
    tickBurn: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Burn) return 0;
        const stacks = unit.statusEffects.Burn;
        const burnDmg = stacks;
        if (burnDmg > 0) {
            unit.hp = Math.max(0, unit.hp - burnDmg);
            spawnFloatText(unitId, `-${burnDmg}`, 'text-orange-500');
            log(`${unit.name} burns for ${burnDmg} damage!`, 'dmg');
            updateUI(unitId);
            // Reduce stacks by 1
            unit.statusEffects.Burn = Math.max(0, stacks - 1);
            if (unit.statusEffects.Burn <= 0) delete unit.statusEffects.Burn;
            updateStatusBadges(unitId);
        }
        return burnDmg;
    },
    
    // Weaken: Returns damage multiplier (reduced outgoing damage)
    getWeakenMultiplier: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || !unit.statusEffects?.Weaken) return 1;
        const stacks = unit.statusEffects.Weaken;
        return Math.max(0.4, 1 - (stacks * 0.15)); // 15% reduction per stack, min 40% damage
    },
    
    // Vulnerable: Returns damage multiplier (increased incoming damage)
    getVulnerableMultiplier: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || !unit.statusEffects?.Vulnerable) return 1;
        const stacks = unit.statusEffects.Vulnerable;
        return 1 + (stacks * 0.2); // 20% increase per stack
    },
    
    // Tick Bleed: Reduce stacks by 1 at turn end
    tickBleed: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Bleed) return;
        unit.statusEffects.Bleed = Math.max(0, unit.statusEffects.Bleed - 1);
        if (unit.statusEffects.Bleed <= 0) {
            delete unit.statusEffects.Bleed;
            log(`${unit.name}'s bleed fades.`, 'sys');
        }
        updateStatusBadges(unitId);
    },
    
    // Tick Rupture: Reduce stacks by 1 at turn end and reset accumulator
    tickRupture: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Rupture) return;
        unit.statusEffects.Rupture = Math.max(0, unit.statusEffects.Rupture - 1);
        if (unit.statusEffects.Rupture <= 0) {
            delete unit.statusEffects.Rupture;
            unit.ruptureDamageAccum = 0;
            log(`${unit.name}'s rupture fades.`, 'sys');
        }
        updateStatusBadges(unitId);
    },
    
    // Tick Weaken: Reduce stacks by 1 at turn end
    tickWeaken: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Weaken) return;
        unit.statusEffects.Weaken = Math.max(0, unit.statusEffects.Weaken - 1);
        if (unit.statusEffects.Weaken <= 0) {
            delete unit.statusEffects.Weaken;
            log(`${unit.name}'s weakness fades.`, 'sys');
        }
        updateStatusBadges(unitId);
    },
    
    // Tick Vulnerable: Reduce stacks by 1 at turn end
    tickVulnerable: (unitId) => {
        const unit = GameState.units[unitId];
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Vulnerable) return;
        unit.statusEffects.Vulnerable = Math.max(0, unit.statusEffects.Vulnerable - 1);
        if (unit.statusEffects.Vulnerable <= 0) {
            delete unit.statusEffects.Vulnerable;
            log(`${unit.name}'s vulnerability fades.`, 'sys');
        }
        updateStatusBadges(unitId);
    }
};

// Helper to apply a status effect to a unit
function applyStatusEffect(unitId, effectName, stacks = 1) {
    const unit = GameState.units[unitId];
    if (!unit || unit.hp <= 0) return;
    const def = StatusEffectDefinitions[effectName];
    if (!def) return;
    
    if (!unit.statusEffects) unit.statusEffects = {};
    
    if (def.stackable) {
        unit.statusEffects[effectName] = Math.min(
            (unit.statusEffects[effectName] || 0) + stacks,
            def.maxStacks
        );
    } else {
        unit.statusEffects[effectName] = stacks;
    }
    
    log(`${unit.name} gains ${effectName} (${unit.statusEffects[effectName]} stacks)!`, 'sys');
    updateStatusBadges(unitId);
}

// Helper to remove a status effect
function removeStatusEffect(unitId, effectName) {
    const unit = GameState.units[unitId];
    if (!unit || !unit.statusEffects) return;
    delete unit.statusEffects[effectName];
    updateStatusBadges(unitId);
}

// Update status effect badges on a unit card
function updateStatusBadges(unitId) {
    const unit = GameState.units[unitId];
    const card = document.getElementById(unitId);
    if (!card) return;
    
    let badgesContainer = card.querySelector('.status-badges');
    if (!badgesContainer) {
        badgesContainer = document.createElement('div');
        badgesContainer.className = 'status-badges flex flex-wrap gap-1 mt-1';
        const cardContent = card.querySelector('.card-content');
        if (cardContent) cardContent.appendChild(badgesContainer);
    }
    
    if (!unit || !unit.statusEffects || Object.keys(unit.statusEffects).length === 0) {
        badgesContainer.innerHTML = '';
        return;
    }
    
    badgesContainer.innerHTML = Object.entries(unit.statusEffects).map(([name, stacks]) => {
        const def = StatusEffectDefinitions[name];
        if (!def) return '';
        return `<span class="${def.color} bg-slate-800 px-1 py-0.5 rounded text-[10px] font-bold" title="${def.desc}">${def.icon}${stacks}</span>`;
    }).join('');
}

// Process turn-start status effects (poison)
function processStatusEffectsTurnStart() {
    Object.keys(GameState.units).forEach(unitId => {
        const unit = GameState.units[unitId];
        if (unit && unit.hp > 0) {
            StatusEffectFunctions.tickPoison(unitId);
        }
    });
}

// Process turn-end status effects (burn, bleed, rupture, weaken, vulnerable)
function processStatusEffectsTurnEnd() {
    Object.keys(GameState.units).forEach(unitId => {
        const unit = GameState.units[unitId];
        if (unit && unit.hp > 0) {
            StatusEffectFunctions.tickBurn(unitId);
            StatusEffectFunctions.tickBleed(unitId);
            StatusEffectFunctions.tickRupture(unitId);
            StatusEffectFunctions.tickWeaken(unitId);
            StatusEffectFunctions.tickVulnerable(unitId);
        }
    });
}

// Parameter metadata definitions (will be populated from server)
let ParameterDefinitions = {};

// Parameter effect function registry (implementation layer - these stay client-side as they contain logic)
const ParameterFunctions = {
    regeneration: ({ unitId, trigger }) => {
        if (trigger === 'turnStart') {
            const unit = GameState.units[unitId];
            if (unit && unit.hp > 0) {
                const healAmt = 2;
                unit.hp = Math.min(unit.maxHp, unit.hp + healAmt);
                spawnFloatText(unitId, `+${healAmt}`, 'text-emerald-400');
                updateUI(unitId);
                log(`${unit.name} regenerates ${healAmt} HP.`, 'heal');
            }
        }
    },
    fortify: ({ unitId, damage, trigger }) => {
        if (trigger === 'onDamageTaken') {
            return Math.max(0, damage - 1);
        }
        return damage;
    },
    powerStrike: ({ unitId, damage, trigger }) => {
        if (trigger === 'onDamageDealt') {
            return damage + 3;
        }
        return damage;
    },
    quickStep: ({ unitId, speed, trigger }) => {
        if (trigger === 'onSpeedRoll') {
            return speed + 1;
        }
        return speed;
    },
    lifesteal: ({ unitId, damageDealt, trigger }) => {
        if (trigger === 'onHit' && damageDealt > 0) {
            const unit = GameState.units[unitId];
            if (unit && unit.hp > 0) {
                const healAmt = Math.floor(damageDealt * 0.5);
                if (healAmt > 0) {
                    unit.hp = Math.min(unit.maxHp, unit.hp + healAmt);
                    spawnFloatText(unitId, `+${healAmt}`, 'text-emerald-400');
                    updateUI(unitId);
                    log(`${unit.name} lifesteals ${healAmt} HP.`, 'heal');
                }
            }
        }
    },
    bonusHp: ({ unitId, trigger }) => {
        if (trigger === 'onApply') {
            const unit = GameState.units[unitId];
            if (unit) {
                unit.maxHp += 10;
                unit.hp += 10;
                updateUI(unitId);
            }
        } else if (trigger === 'onRemove') {
            const unit = GameState.units[unitId];
            if (unit) {
                unit.maxHp = Math.max(1, unit.maxHp - 10);
                unit.hp = Math.min(unit.hp, unit.maxHp);
                updateUI(unitId);
            }
        }
    },
    bonusDamage: ({ unitId, damage, trigger }) => {
        if (trigger === 'onDamageDealt') {
            return damage + 3;
        }
        return damage;
    },
    venomous: ({ unitId, targetId, trigger }) => {
        if (trigger === 'onHit' && targetId) {
            applyStatusEffect(targetId, 'Poison', 2);
        }
    },
    hemorrhage: ({ unitId, targetId, trigger }) => {
        if (trigger === 'onHit' && targetId) {
            applyStatusEffect(targetId, 'Bleed', 1);
        }
    },
    searing: ({ unitId, targetId, trigger }) => {
        if (trigger === 'onHit' && targetId) {
            applyStatusEffect(targetId, 'Burn', 2);
        }
    },
    rend: ({ unitId, targetId, trigger }) => {
        if (trigger === 'onHit' && targetId) {
            applyStatusEffect(targetId, 'Rupture', 1);
        }
    }
};

// List of available parameters (will be populated from server)
let ParametersList = [];

// Fetch parameter definitions from server
async function fetchParameters() {
    try {
        const res = await fetch('/api/getParameters');
        if (!res.ok) throw new Error("Failed to fetch parameters");
        const data = await res.json();
        if (data.parameters) {
            ParameterDefinitions = data.parameters;
            // Build ParametersList from definitions
            ParametersList = Object.keys(ParameterDefinitions).map(name => ({
                id: name,
                name: name,
                type: ParameterDefinitions[name].type,
                desc: ParameterDefinitions[name].desc
            }));
        }
        return data;
    } catch (e) {
        console.error("Error fetching parameters:", e);
        return null;
    }
}

// Helper to trigger parameter effects on a unit
function triggerParameterEffects(unitId, trigger, context = {}) {
    const unit = GameState.units[unitId];
    if (!unit || !Array.isArray(unit.parameters)) return context;
    
    let result = { ...context };
    unit.parameters.forEach(param => {
        const def = ParameterDefinitions[param.name];
        if (def && def.func && typeof ParameterFunctions[def.func] === 'function') {
            const output = ParameterFunctions[def.func]({ unitId, trigger, ...result });
            if (output !== undefined) {
                // If function returns a value, update result for chaining
                if (typeof output === 'number') {
                    // Assume it's modifying damage/speed/etc based on context
                    if ('damage' in result) result.damage = output;
                    else if ('speed' in result) result.speed = output;
                }
            }
        }
    });
    return result;
}

// UnitData will be populated from server
let UnitData = {
    PCs: {},
    ENs: {}
};

// Fetch unit data from server
async function fetchUnitData(chapter = 1) {
    try {
        const res = await fetch(`/api/getUnits?ch=${chapter}`);
        if (!res.ok) throw new Error("Failed to fetch unit data");
        const data = await res.json();
        UnitData.PCs = data.PCs || {};
        UnitData.ENs = data.ENs || {};
        // Also update PassiveDefinitions from server if provided
        if (data.passives) {
            Object.assign(PassiveDefinitions, data.passives);
        }
        return data;
    } catch (e) {
        console.error("Error fetching unit data:", e);
        return null;
    }
}

let GameState = {
    units: {},
    pendingActions: {}, 
    phase: 'DIALOGUE', // Start in DIALOGUE phase
    turn: 1,
    dragStart: null,
    dragSourceId: null,
    dragCurrent: null,
    visualActions: [],
    actedEnemies: new Set(),
    abilityTargets: {},
    // Whether we still need to perform the initial animated speed roll after dialogue
    needsInitialRoll: true,
    // Planned enemy actions during PLANNING: { [enId]: { srcBoxId, tgt } }
    enemyActions: {},
    // Order of player assignments (for undo)
    assignmentOrder: [],
    
    // Dialogue State
    currentScript: [],
    scriptIndex: 0,
    isTyping: false,
    postCombatCallback: null,
    autoPlayTimer: null,

    // Parameters dragging state
    parameterDragStart: null,
    parameterDragSourceId: null
};

let Script = [{ speaker: "", text: "" }];
let PostVictoryScript = [{ speaker: "", text: "" }];

async function fetchDialogue(ch, i1, i2) {
    try {
        const res = await fetch("/api/getDialogue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ "ch": ch, "i1": i1, "i2": i2 })
        });
        if (!res.ok) throw new Error("Bad response");
        const data = await res.json();
        // Expect either an array directly or { dialogue: [...] }
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.dialogue)) return data.dialogue;
        throw new Error("Unexpected format");
    } catch (e) {
        console.error("Dialogue fetch error:", e);
        return [{ speaker: "SYSTEM", text: "Failed to load dialogue." }];
    }
}

function loadAllDialogues() {
    Promise.all([
        fetchDialogue(1, 0, 0).then(arr => { Script = arr; }),
        fetchDialogue(1, 0, 1).then(arr => { PostVictoryScript = arr; })
    ]).then(() => {
        // If still in initial dialogue phase, restart with loaded script
        if (typeof startDialogue === "function" && GameState.phase === "DIALOGUE") {
            startDialogue(Script);
        }
    });
}

window.addEventListener("load", loadAllDialogues);

// ==========================================
// 2. DIALOGUE ENGINE
// ==========================================
const dialogueBox = document.getElementById('dialogue-box');
const speakerEl = document.getElementById('dialogue-speaker');
const textEl = document.getElementById('dialogue-text');
const btnTurn = document.getElementById('btn-turn');

let typingTimerId = null; // Variable to hold the setTimeout ID for skipping

function startDialogue(script, callback) {
    GameState.currentScript = script;
    GameState.scriptIndex = 0;
    GameState.postCombatCallback = (typeof callback === 'function') ? callback : null;
    dialogueBox.style.opacity = 1;
    dialogueBox.classList.remove('hidden');
    // Prevent user actions during dialogue
    btnTurn.disabled = true;
    GameState.phase = 'DIALOGUE';
    nextDialogue();
}

function displayLine(line) {
    GameState.isTyping = true;
    speakerEl.innerText = line.speaker;
    speakerEl.className = `mr-3 text-xl sm:text-2xl mb-1 sm:mb-2 ${line.color || 'text-amber-400'}`;
    textEl.innerHTML = ""; // Use innerHTML for dynamic content
    
    const textContent = line.text;
    let i = 0;
    
    // Enable normal wrapping
    textEl.style.whiteSpace = 'normal';
    textEl.style.wordBreak = 'break-word';
    textEl.style.overflowWrap = 'anywhere';

    const type = () => {
        if (i < textContent.length) {
            const char = textContent.charAt(i);

            // Use normal spaces so wrapping can occur
            if (char === ' ') {
                textEl.appendChild(document.createTextNode(' '));
            } else {
                textEl.appendChild(document.createTextNode(char));
            }
            i++;

            // Soft-break extremely long words (prevent overflow)
            const words = textEl.textContent.split(' ');
            const lastWord = words[words.length - 1];
            if (lastWord && lastWord.length > 20) { // threshold adjustable
                const base = words.slice(0, -1).join(' ');
                textEl.textContent = base + (base.length ? ' ' : '');
                // Insert <wbr> every 15 chars for long word
                const segments = lastWord.match(/.{1,15}/g) || [lastWord];
                segments.forEach((seg, idx) => {
                    textEl.appendChild(document.createTextNode(seg));
                    if (idx < segments.length - 1) {
                        textEl.appendChild(document.createElement('wbr'));
                    }
                });
            }

            typingTimerId = setTimeout(type, 15);
        } else {
            GameState.isTyping = false;
            typingTimerId = null;
        }
    };
    type();
}

window.nextDialogue = async function() {
    if (GameState.isTyping) {
        // Fix: If currently typing, clear the timer and display full text
        if (typingTimerId !== null) {
            clearTimeout(typingTimerId);
            typingTimerId = null;
        }

        
        
        const line = GameState.currentScript[GameState.scriptIndex - 1];
        // Use textContent so spaces remain break points (avoid mid-word breaks caused by &nbsp;)
        textEl.textContent = line.text;
        GameState.isTyping = false;
        return;
    }

    if (GameState.scriptIndex < GameState.currentScript.length) {
        const line = GameState.currentScript[GameState.scriptIndex];
        displayLine(line);
        GameState.scriptIndex++;
    } else {
        // Dialogue finished
        dialogueBox.style.opacity = 0;
        setTimeout(() => dialogueBox.classList.add('hidden'), 300);

        // If a post-combat callback is registered, call it instead of returning to planning
        if (GameState.postCombatCallback) {
            const cb = GameState.postCombatCallback;
            GameState.postCombatCallback = null;
            // Invoke callback (e.g., to show game-over modal)
            try { cb(); } catch (e) { console.error(e); }
            return;
        }

        GameState.phase = 'PLANNING';
        // If this is the first time leaving dialogue, run the animated speed roll first
        if (GameState.needsInitialRoll) {
            GameState.needsInitialRoll = false;
            btnTurn.disabled = true;
            btnTurn.innerText = "ROLLING...";
            try { await animateRollSpeeds(); } catch (e) { console.error('animateRollSpeeds error', e); }
            btnTurn.disabled = false;
            btnTurn.innerText = "INITIATE COMBAT";
        } else {
            btnTurn.disabled = false;
        }
        log("Ready for action. Assign targets.", 'sys');
    }
}

// Skip all remaining dialogue and go straight to planning phase
window.skipDialogue = async function() {
    // Stop any typing
    if (typingTimerId !== null) {
        clearTimeout(typingTimerId);
        typingTimerId = null;
    }
    GameState.isTyping = false;
    
    // Stop auto-play if running
    if (GameState.autoPlayTimer) {
        clearInterval(GameState.autoPlayTimer);
        GameState.autoPlayTimer = null;
        const btn = document.getElementById('btn-auto');
        if (btn) {
            btn.classList.remove('bg-green-600');
            btn.classList.add('bg-slate-700');
        }
    }
    
    // Hide dialogue box
    dialogueBox.style.opacity = 0;
    setTimeout(() => dialogueBox.classList.add('hidden'), 300);
    
    // If a post-combat callback is registered, call it
    if (GameState.postCombatCallback) {
        const cb = GameState.postCombatCallback;
        GameState.postCombatCallback = null;
        try { cb(); } catch (e) { console.error(e); }
        return;
    }
    
    // Go to planning phase
    GameState.phase = 'PLANNING';
    if (GameState.needsInitialRoll) {
        GameState.needsInitialRoll = false;
        btnTurn.disabled = true;
        btnTurn.innerText = "ROLLING...";
        try { await animateRollSpeeds(); } catch (e) { console.error('animateRollSpeeds error', e); }
        btnTurn.disabled = false;
        btnTurn.innerText = "INITIATE COMBAT";
    } else {
        btnTurn.disabled = false;
    }
    log("Ready for action. Assign targets.", 'sys');
}

// Toggle auto-play mode for dialogue
window.toggleAutoPlay = function() {
    const btn = document.getElementById('btn-auto');
    
    if (GameState.autoPlayTimer) {
        // Stop auto-play
        clearInterval(GameState.autoPlayTimer);
        GameState.autoPlayTimer = null;
        if (btn) {
            btn.classList.remove('bg-green-600');
            btn.classList.add('bg-slate-700');
        }
    } else {
        // Start auto-play
        GameState.autoPlayTimer = setInterval(() => {
            if (GameState.phase !== 'DIALOGUE') {
                clearInterval(GameState.autoPlayTimer);
                GameState.autoPlayTimer = null;
                if (btn) {
                    btn.classList.remove('bg-green-600');
                    btn.classList.add('bg-slate-700');
                }
                return;
            }
            if (!GameState.isTyping) {
                nextDialogue();
            }
        }, 2000); // Advance every 2 seconds when not typing
        
        if (btn) {
            btn.classList.remove('bg-slate-700');
            btn.classList.add('bg-green-600');
        }
    }
}

// ==========================================
// 3. VISUAL ENGINE
// ==========================================
const canvas = document.getElementById('arrow-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function getCenter(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
}

function drawArrow(x1, y1, x2, y2, color, dashed = false) {
    const head = 12;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);

    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.setLineDash(dashed ? [10, 10] : []);

    // Use a quadratic curve to arc upward; fallback to straight if very short
    const useArc = dist > 16;
    let cx = (x1 + x2) / 2;
    let cy = (y1 + y2) / 2;
    if (useArc) {
        const nx = dist === 0 ? 0 : -dy / dist; // unit perpendicular (upward-ish)
        const ny = dist === 0 ? 0 : dx / dist;
        const curveHeight = Math.min(140, dist * 0.35);
        const direction = -1; // bias arc upward on screen
        cx += nx * curveHeight * direction;
        cy += ny * curveHeight * direction;
    }

    ctx.beginPath();
    if (useArc) {
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(cx, cy, x2, y2);
    } else {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    // Arrowhead: align with tangent at end of curve (or line)
    const tanAngle = useArc ? Math.atan2(y2 - cy, x2 - cx) : Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(tanAngle - Math.PI / 6), y2 - head * Math.sin(tanAngle - Math.PI / 6));
    ctx.lineTo(x2 - head * Math.cos(tanAngle + Math.PI / 6), y2 - head * Math.sin(tanAngle + Math.PI / 6));
    ctx.fillStyle = color;
    ctx.fill();

    ctx.setLineDash([]);
}

function spawnFloatText(id, text, color) {
    const center = getCenter(id);
    if(!center) return;
    const el = document.createElement('div');
    el.className = `float-text ${color}`;
    el.innerText = text;
    el.style.left = `${center.x}px`;
    el.style.top = `${center.y - 40}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
}

function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // 1. Planning Lines (Amber Dashed)
    if (GameState.phase === 'PLANNING') {
        // Clean out any plans for dead enemies or dead targets
        if (GameState.enemyActions) {
            Object.keys(GameState.enemyActions).forEach(enId => {
                const plan = GameState.enemyActions[enId];
                const enUnit = GameState.units[enId];
                const tgtUnitId = GameState.abilityTargets[plan?.tgt] || plan?.tgt;
                const tgtUnit = GameState.units[tgtUnitId];
                if (!enUnit || enUnit.hp <= 0 || !tgtUnit || tgtUnit.hp <= 0) {
                    delete GameState.enemyActions[enId];
                }
            });
        }
        // Ensure we have enemy plans to display (generate deterministically if absent)
        if (!GameState.enemyActions || Object.keys(GameState.enemyActions).length === 0) {
            try { computePlannedEnemyActions(); } catch (e) { console.error('computePlannedEnemyActions error', e); }
        }
        // Draw player planned actions (skip those that will be drawn as mutual with enemies below)
        const mutualPairs = new Set();
        Object.entries(GameState.enemyActions || {}).forEach(([enId, eAct]) => {
            // skip dead enemies or plans with dead targets
            const enUnit = GameState.units[enId];
            let enTgtUnit = GameState.abilityTargets[eAct.tgt] || eAct.tgt;
            const tgtUnit = GameState.units[enTgtUnit];
            if (!enUnit || enUnit.hp <= 0) return;
            if (!tgtUnit || tgtUnit.hp <= 0) return;
            // resolve enemy's chosen target unit id
            enTgtUnit = GameState.abilityTargets[eAct.tgt] || eAct.tgt;
            // if that PC has an action targeting this enemy, mark as mutual for that specific PC
            const pcAction = GameState.pendingActions[enTgtUnit];
            if (pcAction) {
                const raw = (typeof pcAction === 'object') ? pcAction.tgt : pcAction;
                const resolved = GameState.abilityTargets[raw] || raw;
                if (resolved === enId) mutualPairs.add(enId + '::' + enTgtUnit);
            }
        });

        Object.entries(GameState.pendingActions).forEach(([srcKey, action]) => {
                let srcIdForCenter = srcKey;
                let tgtVisual = action;
            if (action && typeof action === 'object') {
                srcIdForCenter = action.srcBoxId || srcKey;
                tgtVisual = action.tgt;
            }
                const tgtUnit = GameState.abilityTargets[tgtVisual] || tgtVisual;
                // If this pending action is mutual (enemy also targets this PC), skip drawing here
                // — mutual visuals are drawn in the enemy loop to compute a meeting point.
                if (tgtUnit && String(tgtUnit).startsWith('EN')) {
                    if (mutualPairs.has(tgtUnit + '::' + srcKey)) return;
                }
                // Determine color: if targeting an enemy with multiple attackers, only the highest-speed PC will be the active attacker
                let color = '#fbbf24'; // amber default
                if (tgtUnit && String(tgtUnit).startsWith('EN')) {
                    // collect attackers for this enemy
                    const attackers = Object.entries(GameState.pendingActions)
                        .filter(([pId, act]) => {
                            const raw = (act && typeof act === 'object') ? act.tgt : act;
                            const resolved = GameState.abilityTargets[raw] || raw;
                            return resolved === (GameState.abilityTargets[tgtVisual] || tgtVisual);
                        }).map(([pId]) => pId);
                    if (attackers.length > 1) {
                        // pick highest-speed PC as real attacker
                        let best = attackers[0];
                        attackers.forEach(a => {
                            const aspeed = GameState.units[a]?.speed || 0;
                            const bspeed = GameState.units[best]?.speed || 0;
                            if (aspeed > bspeed) best = a;
                        });
                        if (srcKey !== best) color = '#10b981'; // green for queued non-attacker
                    }
                }
                const s = getCenter(srcIdForCenter);
                const t = getCenter(tgtVisual);
                if (s && t) drawArrow(s.x, s.y, t.x, t.y, color, true);
        });

        // Draw enemy planned actions (red dashed). If mutual engagement exists with a PC that targets the enemy, draw two arrows that meet.
        Object.entries(GameState.enemyActions || {}).forEach(([enId, eAct]) => {
            // skip dead enemies or plans with dead targets
            const enUnit2 = GameState.units[enId];
            const enTgtUnit2 = GameState.abilityTargets[eAct.tgt] || eAct.tgt;
            const tgtUnit2 = GameState.units[enTgtUnit2];
            if (!enUnit2 || enUnit2.hp <= 0) return;
            if (!tgtUnit2 || tgtUnit2.hp <= 0) return;
            const enSrcVisual = eAct.srcBoxId || enId;
            const enTgtVisual = eAct.tgt;
            const enSrcCenter = getCenter(enSrcVisual) || getCenter(enId);
            const enTgtUnit = GameState.abilityTargets[enTgtVisual] || enTgtVisual;
            const pcAction = GameState.pendingActions[enTgtUnit];
            const pcSrcVisual = (pcAction && typeof pcAction === 'object') ? (pcAction.srcBoxId || enTgtUnit) : enTgtUnit;
            const pcCenter = getCenter(pcSrcVisual) || getCenter(enTgtUnit);

            if (enSrcCenter && pcCenter) {
                // Mutual if that PC is targeting this enemy
                let isMutual = false;
                if (pcAction) {
                    const raw = (typeof pcAction === 'object') ? pcAction.tgt : pcAction;
                    const resolved = GameState.abilityTargets[raw] || raw;
                    if (resolved === enId) isMutual = true;
                }

                if (isMutual) {
                    // compute meeting point biased by relative roll strengths
                    const pcStrength = Math.max(1, (GameState.units[enTgtUnit]?.ability?.rolls) || (GameState.units[enTgtUnit]?.ability?.rolls === 0 ? 1 : 1));
                    const enStrength = Math.max(1, (GameState.units[enId]?.ability?.rolls) || (GameState.units[enId]?.ability?.rolls === 0 ? 1 : 1));
                    const frac = pcStrength / (pcStrength + enStrength);
                    const mx = pcCenter.x + frac * (enSrcCenter.x - pcCenter.x);
                    const my = pcCenter.y + frac * (enSrcCenter.y - pcCenter.y);
                    // To avoid overlapping arrowheads we shorten each arrow slightly so heads don't collide
                    const headGap = 0; // minimal gap so heads almost touch
                    // PC -> meeting (shortened); head follows curve tangent automatically
                    const anglePC = Math.atan2(my - pcCenter.y, mx - pcCenter.x);
                    const pcEndX = mx - headGap * Math.cos(anglePC);
                    const pcEndY = my - headGap * Math.sin(anglePC);
                    drawArrow(pcCenter.x, pcCenter.y, pcEndX, pcEndY, '#fbbf24', true);
                    // EN -> meeting (shortened from other side); head follows curve tangent automatically
                    const angleEN = Math.atan2(my - enSrcCenter.y, mx - enSrcCenter.x);
                    const enEndX = mx - headGap * Math.cos(angleEN);
                    const enEndY = my - headGap * Math.sin(angleEN);
                    drawArrow(enSrcCenter.x, enSrcCenter.y, enEndX, enEndY, '#ef4444', true);
                } else {
                    // normal enemy arrow full-length
                    drawArrow(enSrcCenter.x, enSrcCenter.y, pcCenter.x, pcCenter.y, '#ef4444', true);
                }
            }
        });
    }

    // 2. Dragging Line (White Dashed)
    if (GameState.dragStart && GameState.dragCurrent) {
        drawArrow(GameState.dragStart.x, GameState.dragStart.y, GameState.dragCurrent.x, GameState.dragCurrent.y, '#ffffff', true);
    }

    // 3. Combat Animations (Solid Colors)
    GameState.visualActions.forEach(a => {
        const s = getCenter(a.src);
        const t = getCenter(a.tgt);
        if (s && t) drawArrow(s.x, s.y, t.x, t.y, a.color, false);
    });

    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ==========================================
// 4. COMBAT LOGIC
// ==========================================

function log(msg, type='def') {
    const el = document.getElementById('combat-log');
    const div = document.createElement('div');
    const colors = { 
        def: 'text-slate-400', 
        dmg: 'text-red-400 font-bold', 
        heal: 'text-emerald-400 font-bold', 
        sys: 'text-amber-400', 
        duel: 'text-cyan-400 font-bold',
        tie: 'text-orange-400',
        tank: 'text-blue-400' // New color for Tank ability
    };
    div.className = colors[type] || colors.def;
    div.innerText = `> ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

function applyDamage(id, amt) {
    const u = GameState.units[id];
        if (!u || u.hp <= 0) return; // Check if unit exists and is alive
    u.hp = Math.max(0, u.hp - amt);
    updateUI(id);
}

function applyHeal(id, amt) {
    const u = GameState.units[id];
        if (!u || u.hp <= 0) return; // Check if unit exists and is alive
    u.hp = Math.min(u.maxHp, u.hp + amt);
    spawnFloatText(id, `+${amt}`, 'text-emerald-400');
    updateUI(id);
}

// Special Ability Logic
async function handleChain(srcId, tgtId) {
    const others = Object.keys(GameState.units).filter(k => k.startsWith('EN') && k !== tgtId && GameState.units[k].hp > 0);
    if (others.length > 0) {
        const jumpId = others[Math.floor(Math.random() * others.length)];
        const dmg = 6;
        await applyDamageWithIndicators(srcId, jumpId, dmg, 'text-purple-400');
        log(`${GameState.units[srcId].name} Chain Strike jumped to ${GameState.units[jumpId].name}.`, 'sys');
        checkDeaths();
    }
}

function handleSustainProtocol(srcId) {
    const healAmt = 5;
    applyHeal(srcId, healAmt);
    log(`${GameState.units[srcId].name} activates Sustain Protocol, restoring ${healAmt} HP.`, 'tank');
}

// ==========================================
// 5. EXECUTION PHASE
// ==========================================

async function resolveCombat() {
    const hasActions = Object.keys(GameState.pendingActions).length > 0;
    if (!hasActions) { log("No orders assigned! Press Initiate Combat when ready.", 'sys'); return; }

    const btn = document.getElementById('btn-turn');
    GameState.phase = 'EXECUTING';
    GameState.actedEnemies.clear();
    btn.disabled = true;
    btn.innerText = "FIGHTING...";
    document.getElementById('turn-indicator').innerText = "COMBAT PHASE";
    document.getElementById('turn-indicator').className = "text-lg sm:text-2xl font-bold text-red-500 animate-pulse";

    // --- TURN START STATUS EFFECTS (Poison) ---
    processStatusEffectsTurnStart();
    checkDeaths();
    if(checkWinLoss()) return;
    await wait(300);

    // --- PLAYER INITIATED ACTIONS ---
    const playerOrder = Array.isArray(GameState.turnOrder) && GameState.turnOrder.length > 0
        ? GameState.turnOrder.slice()
        : Object.keys(GameState.units).filter(k => k.startsWith('PC'));

    for (const srcId of playerOrder) {
        const action = GameState.pendingActions[srcId];
        if (!action) continue;
        // support legacy (string) format and new object format { srcBoxId, tgt }
        let rawTgtId = action;
        let srcBoxId = null;
        if (action && typeof action === 'object') { rawTgtId = action.tgt; srcBoxId = action.srcBoxId; }
        const tgtId = GameState.abilityTargets[rawTgtId] || rawTgtId; // translate ability box to parent enemy for logic
        const src = GameState.units[srcId];
        const tgt = GameState.units[tgtId];
        if (!src || src.hp <= 0) { log(`${src ? src.name : srcId} is down. Skipping order.`, 'sys'); continue; }
        if (!tgt || tgt.hp <= 0) { log(`${tgt ? tgt.name : 'Target'} already destroyed. Skipping order.`, 'sys'); continue; }

        if (tgt.type === 'EN') GameState.actedEnemies.add(tgtId);

        // Execute player action
        if (tgt.type === 'EN' && src.ability.damage > 0) {
            await resolveDuel(srcId, tgtId, rawTgtId, srcBoxId);
        } else if (tgt.type === 'PC' && src.ability.heal > 0) {
            applyHeal(tgtId, src.ability.heal);
            log(`${src.name} heals ${tgt.name} for ${src.ability.heal}.`, 'heal');
        }

        checkDeaths();
        await wait(400);
        if(checkWinLoss()) return;
    }

    // --- ENEMY PHASE (Unengaged Units) ---
    await resolveUnengagedEnemies();

    // --- TURN END STATUS EFFECTS (Burn) ---
    processStatusEffectsTurnEnd();
    checkDeaths();
    if(checkWinLoss()) return;

    // --- TURN END ---
    if(checkWinLoss()) return;
    
    GameState.phase = 'PLANNING';
    GameState.turn++;
    GameState.pendingActions = {};
    // Remove 'assigned' class from all units
    document.querySelectorAll('.unit-card.assigned').forEach(el => el.classList.remove('assigned'));
    
    document.getElementById('turn-counter').innerText = GameState.turn;
    document.getElementById('turn-indicator').innerText = "PLANNING PHASE";
    document.getElementById('turn-indicator').className = "text-lg sm:text-2xl font-bold text-blue-400";
    // Trigger re-roll of speeds at turn end and reorder players visually
    btn.disabled = true;
    btn.innerText = "ROLLING...";
    try { await animateRollSpeeds(); } catch (e) { console.error('animateRollSpeeds error', e); }
    btn.disabled = false;
    btn.innerText = "INITIATE COMBAT";
    
    // Reset Visuals
    document.querySelectorAll('.winner, .loser').forEach(el => el.classList.remove('winner', 'loser'));
}

async function resolveDuel(srcId, tgtId, visualTgtId = null, visualSrcId = null) {
    const src = GameState.units[srcId];
    const tgt = GameState.units[tgtId];
    if (!src || src.hp <= 0 || !tgt || tgt.hp <= 0) {
        log('Engagement canceled: unit down.', 'sys');
        return;
    }
    
    // Visual Setup
    const vis = { src: visualSrcId || srcId, tgt: visualTgtId || tgtId, color: '#ffffff' };
    GameState.visualActions.push(vis);
    
    const isRollingEnemy = (tgt.ability.type === 'Rolling');
    let pcHit = false;
    
    if (isRollingEnemy) {
        // --- ROLLING DUEL ---
        vis.color = '#38bdf8'; // Cyan
        
        // Use modified rolls
        const pcMin = src.ability.minroll ?? 0;
        const pcMax = src.ability.rolls ?? 0;
        const enMin = tgt.ability.minroll ?? 0;
        const enMax = tgt.ability.rolls ?? 0;

        const pcRoll = pcMin >= pcMax ? pcMin : pcMin + Math.floor(Math.random() * (pcMax - pcMin + 1));
        const enRoll = enMin >= enMax ? enMin : enMin + Math.floor(Math.random() * (enMax - enMin + 1));
        
        spawnFloatText(srcId, `🎲 ${pcRoll}`, 'text-cyan-300');
        spawnFloatText(tgtId, `🎲 ${enRoll}`, 'text-red-300');
        await wait(1000);

        if (pcRoll > enRoll) {
            // PC WINS
            pcHit = true;
            const rollDiff = pcRoll - enRoll;
            log(`Duel: ${src.name} (${pcRoll}) > ${tgt.name} (${enRoll}).`, 'duel');
            document.getElementById(srcId).classList.add('winner');
            document.getElementById(tgtId).classList.add('loser');
            
            await applyDamageWithIndicators(srcId, tgtId, src.ability.damage);
            
            // Apply bleed damage based on roll difference
            StatusEffectFunctions.applyBleed(tgtId, tgt.statusEffects?.Bleed || 0, rollDiff);
        } else if (pcRoll < enRoll) {
            // ENEMY WINS (PC takes damage)
            pcHit = false;
            const rollDiff = enRoll - pcRoll;
            log(`Duel: ${src.name} (${pcRoll}) < ${tgt.name} (${enRoll}). Countered!`, 'dmg');
            document.getElementById(tgtId).classList.add('winner');
            document.getElementById(srcId).classList.add('loser');

            await applyDamageWithIndicators(tgtId, srcId, tgt.ability.damage);
            
            // Apply bleed damage based on roll difference
            StatusEffectFunctions.applyBleed(srcId, src.statusEffects?.Bleed || 0, rollDiff);
        } else { 
            // TIE (Trade)
            pcHit = true; // PC lands a hit in a tie
            vis.color = '#f59e0b';
            log(`Duel Tied (${pcRoll}). Both take damage.`, 'tie');
            
            await applyDamageWithIndicators(srcId, tgtId, src.ability.damage);

            await applyDamageWithIndicators(tgtId, srcId, tgt.ability.damage);

            // Chain Logic in ties
            if (src.ability.effect === 'Chain Strike') await handleChain(srcId, tgtId);
        }
    } else {
        // --- IGNORE TARGET (TRADE) ---
        pcHit = true; // Guaranteed hit on Ignore target
        vis.color = '#f59e0b'; // Orange
        log(`${src.name} engages Ignore unit ${tgt.name}. Trading damage.`, 'tie');
        
        await wait(600);
        
        await applyDamageWithIndicators(srcId, tgtId, src.ability.damage);
        
        await applyDamageWithIndicators(tgtId, srcId, tgt.ability.damage);
        
        if (src.ability.effect === 'Chain Strike') await handleChain(srcId, tgtId);
    }
    
    // --- SUSTAIN PROTOCOL LOGIC ---
    if (src.ability.effect === 'Sustain Protocol' && pcHit) {
        handleSustainProtocol(srcId);
    }
    
    await wait(800);
    GameState.visualActions = GameState.visualActions.filter(v => v !== vis);
    document.querySelectorAll('.winner, .loser').forEach(el => el.classList.remove('winner', 'loser'));
}

async function resolveUnengagedEnemies() {
    const enemies = Object.keys(GameState.units).filter(k => k.startsWith('EN') && GameState.units[k].hp > 0);
    const activeEnemies = enemies.filter(id => !GameState.actedEnemies.has(id));
    
    if (activeEnemies.length > 0) {
        document.getElementById('turn-indicator').innerText = "ENEMY TURN";
        log("--- Unengaged Enemies Attacking ---", 'sys');
        
        for (const enId of activeEnemies) {
            const en = GameState.units[enId];
            const targets = Object.keys(GameState.units).filter(k => k.startsWith('PC') && GameState.units[k].hp > 0);
            if (targets.length === 0) break;

            // Prefer planned target if available and alive
            let tgtId = null;
            let visualTgt = null;
            const planned = GameState.enemyActions && GameState.enemyActions[enId];
            if (planned) {
                visualTgt = planned.tgt;
                const resolved = GameState.abilityTargets[visualTgt] || visualTgt;
                if (resolved && GameState.units[resolved] && GameState.units[resolved].hp > 0) {
                    tgtId = resolved;
                }
            }
            if (!tgtId) {
                // fallback to random living PC
                tgtId = targets[Math.floor(Math.random() * targets.length)];
                // attempt to use a PC ability-box as visual target
                const pcBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === tgtId);
                visualTgt = pcBox || tgtId;
            }

            document.getElementById(enId).classList.add('acting');
            // Prefer enemy ability-box as visual source if available
            const enBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === enId);
            const visSrc = enBox || enId;
            const vis = { src: visSrc, tgt: visualTgt || tgtId, color: '#ef4444' };
            GameState.visualActions.push(vis);
            await wait(800);

            applyDamageWithIndicators(enId, tgtId, en.ability.damage);
            log(`${en.name} free hit on ${GameState.units[tgtId].name}.`, 'dmg');
            
            GameState.visualActions = GameState.visualActions.filter(v => v !== vis);
            document.getElementById(enId).classList.remove('acting');
            checkDeaths();
            await wait(400);
            if(checkWinLoss()) return;
        }
    }
}


// ==========================================
// 6. UTILS
// ==========================================

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Roll unique d20 speeds for player characters. If any ties occur, reroll the tied participants until all speeds are unique.
// Generate unique d20 speeds for PCs and return { speeds, order }
function generateUniqueSpeedsForPCs() {
    const pcIds = Object.keys(GameState.units).filter(k => k.startsWith('PC'));
    const speeds = {};

    // initial rolls
    pcIds.forEach(id => speeds[id] = 1 + Math.floor(Math.random() * 20));

    // resolve ties: while any duplicate values exist, reroll only tied participants
    function findDuplicates(map) {
        const rev = {};
        Object.entries(map).forEach(([id, v]) => { rev[v] = rev[v] || []; rev[v].push(id); });
        const dups = Object.values(rev).filter(arr => arr.length > 1);
        return dups;
    }

    let dups = findDuplicates(speeds);
    while (dups.length > 0) {
        // reroll every id in each duplicate group
        dups.forEach(group => {
            group.forEach(id => { speeds[id] = 1 + Math.floor(Math.random() * 20); });
        });
        dups = findDuplicates(speeds);
    }

    // produce a sorted order (desc)
    const order = pcIds.slice().sort((a,b) => speeds[b] - speeds[a]);
    return { speeds, order };
}

// Roll unique d20 speeds for enemies and return { speeds, order }
function generateUniqueSpeedsForEnemies() {
    const enIds = Object.keys(GameState.units).filter(k => k.startsWith('EN') && GameState.units[k].hp > 0);
    const speeds = {};
    enIds.forEach(id => speeds[id] = 1 + Math.floor(Math.random() * 20));

    function findDuplicates(map) {
        const rev = {};
        Object.entries(map).forEach(([id, v]) => { rev[v] = rev[v] || []; rev[v].push(id); });
        return Object.values(rev).filter(arr => arr.length > 1);
    }

    let dups = findDuplicates(speeds);
    while (dups.length > 0) {
        dups.forEach(group => {
            group.forEach(id => { speeds[id] = 1 + Math.floor(Math.random() * 20); });
        });
        dups = findDuplicates(speeds);
    }

    const order = enIds.slice().sort((a,b) => speeds[b] - speeds[a]);
    return { speeds, order };
}

function rollUniqueSpeedsForPCs() {
    const { speeds, order } = generateUniqueSpeedsForPCs();
    Object.keys(speeds).forEach(id => { if (GameState.units[id]) GameState.units[id].speed = speeds[id]; });
    GameState.turnOrder = order;
    const parts = order.map(id => `${GameState.units[id].name || id}(${speeds[id]})`);
    log(`Speed rolls: ${parts.join(' • ')}`, 'sys');
    log(`Turn order: ${order.map(id => GameState.units[id].name || id).join(' → ')}`, 'sys');
}

// Compute planned enemy actions: for each living enemy pick a living PC target and store visual ids
function computePlannedEnemyActions(force = false) {
    // If already have plans and not forcing, keep them (stable planning)
    const existing = GameState.enemyActions || {};
    const enemyIds = Object.keys(GameState.units).filter(k => k.startsWith('EN') && GameState.units[k].hp > 0);
    const pcIds = (Array.isArray(GameState.turnOrder) && GameState.turnOrder.length>0)
        ? GameState.turnOrder.filter(id => GameState.units[id] && GameState.units[id].hp>0)
        : Object.keys(GameState.units).filter(k => k.startsWith('PC') && GameState.units[k].hp > 0);
    if (enemyIds.length === 0 || pcIds.length === 0) { GameState.enemyActions = {}; return; }

    if (!force && Object.keys(existing).length > 0) {
        // fill missing entries only
        enemyIds.forEach((enId, idx) => {
            if (existing[enId]) return;
            const tgtId = pcIds[idx % pcIds.length];
            const enBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === enId);
            const pcBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === tgtId);
            existing[enId] = { srcBoxId: enBox || enId, tgt: pcBox || tgtId };
        });
        GameState.enemyActions = existing;
        // Save baseline plans so enemies can revert when player undoes assignments
        try { GameState.enemyBaseActions = JSON.parse(JSON.stringify(GameState.enemyActions || {})); } catch (e) { GameState.enemyBaseActions = Object.assign({}, GameState.enemyActions || {}); }
        return;
    }

    // force or no existing plans: roll enemy speeds (secret) and map highest-speed enemies
    // to lowest-HP PCs (1st -> lowest HP, 2nd -> 2nd lowest, etc.)
    const { speeds: enSpeeds, order: enOrder } = generateUniqueSpeedsForEnemies();
    // sort PCs by HP ascending
    const pcByHp = pcIds.slice().sort((a,b) => (GameState.units[a].hp || 0) - (GameState.units[b].hp || 0));
    const plans = {};
    enOrder.forEach((enId, idx) => {
        const tgtId = pcByHp[idx % pcByHp.length];
        const enBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === enId);
        const pcBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === tgtId);
        plans[enId] = { srcBoxId: enBox || enId, tgt: pcBox || tgtId };
    });
    GameState.enemyActions = plans;
    // Save baseline plans so enemies can revert when player undoes assignments
    try { GameState.enemyBaseActions = JSON.parse(JSON.stringify(GameState.enemyActions || {})); } catch (e) { GameState.enemyBaseActions = Object.assign({}, GameState.enemyActions || {}); }
}

// Update enemy plans based on current pending player actions: if multiple PCs target same enemy,
// the enemy will counter the highest-speed attacker; otherwise leave existing plan.
function updateEnemyPlansFromPending() {
    if (!GameState.enemyActions) GameState.enemyActions = {};
    // Ensure baseline plans exist and capture them if missing
    if (!GameState.enemyBaseActions || Object.keys(GameState.enemyBaseActions).length === 0) {
        try { computePlannedEnemyActions(false); } catch (e) { /* ignore */ }
        try { GameState.enemyBaseActions = JSON.parse(JSON.stringify(GameState.enemyActions || {})); } catch (e) { GameState.enemyBaseActions = Object.assign({}, GameState.enemyActions || {}); }
    }

    const enemyIds = Object.keys(GameState.units).filter(k => k.startsWith('EN') && GameState.units[k].hp > 0);
    enemyIds.forEach(enId => {
        // find all PCs targeting this enemy
        const attackers = Object.entries(GameState.pendingActions)
            .filter(([pId, act]) => {
                const raw = (act && typeof act === 'object') ? act.tgt : act;
                const resolved = GameState.abilityTargets[raw] || raw;
                return resolved === enId;
            }).map(([pId]) => pId);

        if (attackers.length > 0) {
            // choose highest-speed attacker; break ties with turnOrder
            let best = attackers[0];
            attackers.forEach(a => {
                const as = GameState.units[a]?.speed || 0;
                const bs = GameState.units[best]?.speed || 0;
                if (as > bs) best = a;
                else if (as === bs) {
                    const to = GameState.turnOrder || [];
                    const ai = to.indexOf(a), bi = to.indexOf(best);
                    if (ai >= 0 && bi >= 0 && ai < bi) best = a;
                }
            });
            const enBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === enId);
            const pcAct = GameState.pendingActions[best];
            const pcVisual = (pcAct && typeof pcAct === 'object') ? (pcAct.srcBoxId || best) : best;
            GameState.enemyActions[enId] = { srcBoxId: enBox || enId, tgt: pcVisual };
        } else {
            // no attackers: restore baseline plan if available, otherwise remove entry
            if (GameState.enemyBaseActions && GameState.enemyBaseActions[enId]) {
                GameState.enemyActions[enId] = JSON.parse(JSON.stringify(GameState.enemyBaseActions[enId]));
            } else {
                if (GameState.enemyActions && GameState.enemyActions[enId]) delete GameState.enemyActions[enId];
            }
        }
    });
}

function undoLastAssignment() {
    if (!GameState.assignmentOrder || GameState.assignmentOrder.length === 0) return;
    const last = GameState.assignmentOrder.pop();
    if (!last) return;
    // last can be stored as { pcId, abilityBoxId } or just pcId in older edits
    const pcId = (typeof last === 'string') ? last : (last.pcId || last);
    // remove pending action for that PC
    if (GameState.pendingActions && GameState.pendingActions[pcId]) {
        delete GameState.pendingActions[pcId];
    }
    // remove visual markers
    const pcCard = document.getElementById(pcId);
    if (pcCard) {
        const boxes = pcCard.querySelectorAll('.ability-box.assigned');
        boxes.forEach(b => b.classList.remove('assigned'));
    }
    updateEnemyPlansFromPending();
}

function resetAssignments() {
    GameState.assignmentOrder = [];
    GameState.pendingActions = {};
    // remove assigned classes from all ability boxes
    document.querySelectorAll('.ability-box.assigned').forEach(el => el.classList.remove('assigned'));
    // Clear all parameters from all units
    Object.keys(GameState.units).forEach(unitId => {
        GameState.units[unitId].parameters = [];
        document.querySelectorAll(`#${unitId} .parameter-badges`).forEach(el => el.remove());
    });
    updateEnemyPlansFromPending();
}

// Animate speed rolling for PCs: show rapid random numbers on badges, then set final speeds and animate reorder via FLIP.
async function animateRollSpeeds(duration = 900) {
    const pcIds = Object.keys(GameState.units).filter(k => k.startsWith('PC'));
    if (pcIds.length === 0) return;

    // Ensure badges exist
    pcIds.forEach(id => {
        const u = GameState.units[id];
        const el = document.getElementById(id);
        if (!el) return;
        let sp = el.querySelector('.speed-badge');
        if (!sp) {
            sp = document.createElement('span');
            sp.className = 'speed-badge absolute top-1 left-1 px-1 py-0.5 bg-indigo-600 text-[8px] sm:text-[10px] font-bold rounded text-white tracking-wider';
            el.appendChild(sp);
        }
        sp.innerText = 'SP —';
    });

    // animation: randomize badges rapidly
    const interval = 60;
    let elapsed = 0;
    const rollTimer = setInterval(() => {
        pcIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const sp = el.querySelector('.speed-badge');
            if (!sp) return;
            sp.innerText = `SP ${1 + Math.floor(Math.random() * 20)}`;
        });
        elapsed += interval;
    }, interval);

    await wait(duration);
    clearInterval(rollTimer);

    // Determine final speeds
    const { speeds, order } = generateUniqueSpeedsForPCs();
    // set speeds on GameState
    Object.keys(speeds).forEach(id => { if (GameState.units[id]) GameState.units[id].speed = speeds[id]; });
    GameState.turnOrder = order;

    // Set final badge text
    order.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const sp = el.querySelector('.speed-badge');
        if (sp) sp.innerText = `SP ${speeds[id]}`;
    });

    // Log rolls
    const parts = order.map(id => `${GameState.units[id].name || id}(${speeds[id]})`);
    log(`Speed rolls: ${parts.join(' • ')}`, 'sys');
    log(`Turn order: ${order.map(id => GameState.units[id].name || id).join(' → ')}`, 'sys');

    // Small delay before animating so players can see final speeds
    await wait(300);

    // Animate reorder of player cards
    const pCon = document.getElementById('player-container');
    if (pCon && order.length > 0) {
        await flipReorder(pCon, order);
    }

    // After speeds and reorder are set, force enemy speed re-roll and compute planned enemy targets for the upcoming planning phase
    try { computePlannedEnemyActions(true); } catch (e) { console.error('computePlannedEnemyActions error', e); }
}

// FLIP reorder animation: container element and array of ids (new order)
function flipReorder(container, newOrder) {
    return new Promise(resolve => {
        const firstRects = {};
        newOrder.forEach(id => {
            const el = document.getElementById(id);
            if (el) firstRects[id] = el.getBoundingClientRect();
        });

        // Reorder DOM to the new order
        newOrder.forEach(id => {
            const el = document.getElementById(id);
            if (el) container.appendChild(el);
        });

        // Animate from old -> new using FLIP: apply inverse transform then animate to identity
        let remaining = newOrder.length;
        const cleanupAndMaybeResolve = () => {
            remaining--; if (remaining <= 0) resolve();
        };

        newOrder.forEach(id => {
            const el = document.getElementById(id);
            if (!el) { cleanupAndMaybeResolve(); return; }
            const oldRect = firstRects[id];
            const newRect = el.getBoundingClientRect();
            const dx = oldRect ? (oldRect.left - newRect.left) : 0;
            const dy = oldRect ? (oldRect.top - newRect.top) : 0;

            if (dx === 0 && dy === 0) { cleanupAndMaybeResolve(); return; }

            // Disable default card transitions during FLIP
            el.style.transition = 'none';
            
            // Prepare element for animation (apply inverse transform)
            el.style.willChange = 'transform';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            
            // Force reflow to ensure the browser applies the transform
            el.getBoundingClientRect();

            // Now animate to identity with smooth easing (override any existing transition)
            el.style.transition = 'transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1)';
            
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    el.style.transform = 'translate(0px, 0px)';
                });
            });

            const onEnd = (ev) => {
                if (ev && ev.propertyName !== 'transform') return;
                el.style.transition = '';
                el.style.transform = '';
                el.style.willChange = '';
                el.removeEventListener('transitionend', onEnd);
                cleanupAndMaybeResolve();
            };
            el.addEventListener('transitionend', onEnd);
            // Safety fallback in case transitionend doesn't fire
            setTimeout(() => {
                if (el) {
                    el.style.transition = '';
                    el.style.transform = '';
                    el.style.willChange = '';

                }
                // ensure counter progresses if transitionend missed
                if (remaining > 0) { cleanupAndMaybeResolve(); }
            }, 700);
        });
    });
}

// Auto-scroll the page when a drag position is near the viewport edges.
// `y` is the clientY coordinate of the pointer/touch.
function autoScrollIfNeeded(y) {
    try {
        const threshold = 80; // px from edge to start scrolling
        const maxStep = 18; // max px per frame to scroll
        const scrollEl = document.scrollingElement || document.documentElement;
        if (!scrollEl) return;

        // If the page is not scrollable, nothing to do
        if (scrollEl.scrollHeight <= window.innerHeight) return;

        if (y < threshold) {
            const pct = (threshold - y) / threshold; // 0..1
            const amt = Math.max(2, Math.round(pct * maxStep));
            window.scrollBy(0, -amt);
        } else if (window.innerHeight - y < threshold) {
            const pct = (threshold - (window.innerHeight - y)) / threshold; // 0..1
            const amt = Math.max(2, Math.round(pct * maxStep));
            window.scrollBy(0, amt);
        }
    } catch (e) {
        // Fail silently — QoL helper shouldn't break combat
        console.error('autoScrollIfNeeded error', e);
    }
}

function checkDeaths() {
    Object.keys(GameState.units).forEach(id => {
        const u = GameState.units[id];
        if (u.hp <= 0) {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('opacity-50')) {
                el.classList.add('opacity-50', 'grayscale');
                el.draggable = false;
                // Remove any pending action where the source unit is the dead unit
                if (GameState.pendingActions[id]) delete GameState.pendingActions[id];
                // Remove actions targeting dead unit (visual target may be string or object)
                for (const [k, v] of Object.entries(GameState.pendingActions)) {
                    if (!v) continue;
                    if (typeof v === 'string') {
                        // visual target could be an ability-box id or unit id
                        const targetUnit = GameState.abilityTargets[v] || v;
                        if (targetUnit === id) delete GameState.pendingActions[k];
                    } else if (typeof v === 'object') {
                        const visual = v.tgt;
                        const targetUnit = GameState.abilityTargets[visual] || visual;
                        if (targetUnit === id) delete GameState.pendingActions[k];
                    }
                }
            }
        }
    });
    // After resolving deaths, recompute planned enemy actions for updated unit lists
    try { computePlannedEnemyActions(); } catch (e) { /* silent */ }
}

// Passive metadata definitions (looked up by name on units)
const PassiveDefinitions = {
    "Aero-Mesh": { desc: "Takes 2 less damage from Rolling attacks", func: "aeroMesh" }
};

// Passive effect function registry (implementation layer)
const PassiveFunctions = {
    aeroMesh: ({ sourceId, targetId, damage }) => {
        return Math.max(0, damage - 2);
    }
};

// Compute final damage taking defender passive names into account
function computeDamageTaken(sourceId, targetId, baseDamage) {
    const defender = GameState.units[targetId];
    if (!defender || baseDamage <= 0) return baseDamage;
    let dmg = baseDamage;
    if (Array.isArray(defender.passives)) {
        defender.passives.forEach(name => {
            const meta = PassiveDefinitions[name];
            if (meta && meta.func && typeof PassiveFunctions[meta.func] === 'function') {
                dmg = PassiveFunctions[meta.func]({ sourceId, targetId, damage: dmg });
            }
        });
    }
    return dmg;
}

// Compute detailed damage result including per-passive modifiers and status effects
function computeDamageDetail(sourceId, targetId, baseDamage) {
    const defender = GameState.units[targetId];
    const attacker = GameState.units[sourceId];
    if (!defender || baseDamage <= 0) return { final: Math.max(0, baseDamage), mods: [] };
    let dmg = baseDamage;
    const mods = [];
    
    // Apply Weaken (attacker deals less damage)
    if (attacker) {
        const weakenMult = StatusEffectFunctions.getWeakenMultiplier(sourceId);
        if (weakenMult < 1) {
            const before = dmg;
            dmg = Math.floor(dmg * weakenMult);
            mods.push({ name: 'Weaken', delta: dmg - before });
        }
    }
    
    // Apply defender passives
    if (Array.isArray(defender.passives)) {
        defender.passives.forEach(name => {
            const meta = PassiveDefinitions[name];
            if (meta && meta.func && typeof PassiveFunctions[meta.func] === 'function') {
                const before = dmg;
                const after = PassiveFunctions[meta.func]({ sourceId, targetId, damage: dmg });
                if (after !== before) mods.push({ name, delta: after - before });
                dmg = after;
            }
        });
    }
    
    // Apply Vulnerable (defender takes more damage)
    const vulnMult = StatusEffectFunctions.getVulnerableMultiplier(targetId);
    if (vulnMult > 1) {
        const before = dmg;
        dmg = Math.floor(dmg * vulnMult);
        mods.push({ name: 'Vulnerable', delta: dmg - before });
    }
    
    return { final: Math.max(0, dmg), mods };
}

// Apply damage and show indicators for original vs final damage when modified
async function applyDamageWithIndicators(sourceId, targetId, baseDamage, color = 'text-red-500') {
    const detail = computeDamageDetail(sourceId, targetId, baseDamage);
    if (detail.mods.length > 0) {
        // Show original in muted color, then final with reasons after delay
        spawnFloatText(targetId, `-${baseDamage}`, 'text-slate-400');
        await wait(500);
        spawnFloatText(targetId, `-${detail.final}`, color);
        applyDamage(targetId, detail.final);
    } else {
        spawnFloatText(targetId, `-${detail.final}`, color);
        applyDamage(targetId, detail.final);
    }
    
    // Trigger onHit parameter effects for the attacker (e.g., venomous, hemorrhage)
    if (detail.final > 0) {
        triggerParameterEffects(sourceId, 'onHit', { targetId, damageDealt: detail.final });
    }
    
    // Check for rupture after damage is applied
    if (detail.final > 0) {
        StatusEffectFunctions.checkRupture(targetId, detail.final);
    }
    
    return detail.final;
}

function checkWinLoss() {
    const pcs = Object.keys(GameState.units).filter(k => k.startsWith('PC') && GameState.units[k].hp > 0);
    const ens = Object.keys(GameState.units).filter(k => k.startsWith('EN') && GameState.units[k].hp > 0);
    
    if (pcs.length === 0) {
        // Immediately show defeat modal (no dialogue)
        showGameOver("DEFEAT", "Your squad was wiped out.", "text-red-500");
        return true;
    }
    if (ens.length === 0) {
        startDialogue(PostVictoryScript, () => showGameOver("VICTORY", "Sector Secured.", "text-blue-400"));
        return true;
    }
    return false;
}

function showGameOver(title, msg, colorClass) {
    const modal = document.getElementById('game-over-modal');
    const titleEl = document.getElementById('modal-title');
    const msgEl = document.getElementById('modal-msg');
    
    titleEl.innerText = title;
    titleEl.className = `text-3xl sm:text-4xl font-black mb-2 uppercase tracking-tighter ${colorClass}`;
    msgEl.innerText = msg;
    
    modal.classList.remove('hidden');
}

// ==========================================
// 7. DRAG & DROP (Desktop & Mobile)
// ==========================================

// Track touch drag state
let touchDragState = {
    srcId: null,
    isDragging: false,
    lastTarget: null
};

// Desktop: Mouse dragover
document.addEventListener('dragover', e => { 
    e.preventDefault(); 
    if (GameState.phase === 'PLANNING') {
        // Keep the arrow base synced with the source element's current center
        if (GameState.dragSourceId) {
            const c = getCenter(GameState.dragSourceId);
            if (c) GameState.dragStart = c;
        }
        GameState.dragCurrent = { x: e.clientX, y: e.clientY };
        // Auto-scroll when dragging near viewport edges for QoL
        autoScrollIfNeeded(e.clientY);
    }
});

// Desktop: Drag start
function handleDragStart(e) {
    if (GameState.phase !== 'PLANNING') { e.preventDefault(); return; }
    // Require dragging from an ability box. ability-box elements set dataTransfer in their own handlers,
    // but fallback here to support cases where the event bubbles from children.
    const ab = e.target.closest('.ability-box');
    if (!ab) { e.preventDefault(); return; }
    const abId = ab.id;
    const parentId = GameState.abilityTargets[abId];
    if (!parentId) { e.preventDefault(); return; }
    if (GameState.units[parentId].hp <= 0) { e.preventDefault(); return; }
    // set dataTransfer as 'unitId|abilityId'
    e.dataTransfer.setData('text/plain', `${parentId}|${abId}`);
    e.dataTransfer.setDragImage(new Image(), 0, 0);
    GameState.dragSourceId = abId; // visual source is ability box
    GameState.dragStart = getCenter(abId);
}

// Desktop: Drop
function handleDrop(e) {
    e.preventDefault();
    if (GameState.phase !== 'PLANNING') return;
    const raw = e.dataTransfer.getData('text/plain');
    const abTarget = e.target.closest('.ability-box');
    const tgtCard = e.target.closest('.unit-card');
    
    if ((tgtCard || abTarget) && raw) {
        const parts = raw.split('|');
        const srcUnitId = parts[0];
        const srcAbId = parts[1] || null;
        // Determine visual target id: prefer ability-box id if dropping onto a box
        let tgtVisualId = abTarget ? abTarget.id : tgtCard.id;
        const src = GameState.units[srcUnitId];
        // Translate visual target to logical unit id
        const parentId = GameState.abilityTargets[tgtVisualId];
        const tgt = GameState.units[parentId || tgtVisualId];
        
        let valid = false;
        // Only allow actions on living targets and from living sources
        if (!src || src.hp <= 0 || !tgt || tgt.hp <= 0) valid = false;
        else {
            // PC attacking EN ability boxes only (must have parent mapping)
            if ((tgt.type === 'EN') && src.ability.damage > 0 && !!parentId) valid = true;
            // PC healing PC
            if (tgt.type === 'PC' && src.ability.heal > 0) valid = true;
        }
        
        if (valid) {
            // Store pending action keyed by source unit id; store both the source ability box and visual target
            GameState.pendingActions[srcUnitId] = { srcBoxId: srcAbId, tgt: tgtVisualId };
            // Mark the source unit card as assigned
            const srcCard = document.getElementById(srcUnitId);
            if (srcCard) srcCard.classList.add('assigned');
            // Track assignment order for undo
            if (!GameState.assignmentOrder.includes(srcUnitId)) GameState.assignmentOrder.push(srcUnitId);
            // Recompute enemy plans based on current pending actions: enemy will target the highest-speed attacker
            try { updateEnemyPlansFromPending(); } catch (e) { console.error('updateEnemyPlansFromPending error', e); }
        }
    }
    GameState.dragStart = null;
    GameState.dragSourceId = null;
    document.querySelectorAll('.target-hover').forEach(el => el.classList.remove('target-hover'));
}

// Ensure dragend clears drag state for desktop drags
document.addEventListener('dragend', e => {
    GameState.dragStart = null;
    GameState.dragSourceId = null;
});

// ==========================================
// MOBILE: TOUCH EVENTS
// ==========================================

// Helper function to validate if a drag action is valid
function isValidDragTarget(srcId, tgtId) {
    const src = GameState.units[srcId];
    const parentId = GameState.abilityTargets[tgtId];
    const tgt = GameState.units[parentId || tgtId];
    
    if (!src || !tgt) return false;
    if (src.hp <= 0 || tgt.hp <= 0) return false;
    
    // PC attacking EN ability boxes only (tgtId must resolve via parentId)
    if (tgt.type === 'EN' && src.ability.damage > 0 && !!parentId) return true;
    // PC healing PC
    if (tgt.type === 'PC' && src.ability.heal > 0) return true;
    
    return false;
}

// Helper function to reset drag state
function resetDragState() {
    document.body.classList.remove('dragging');
    GameState.dragStart = null;
    GameState.dragCurrent = null;
    touchDragState.srcId = null;
    touchDragState.isDragging = false;
    if (touchDragState.lastTarget) {
        touchDragState.lastTarget.classList.remove('target-hover');
        touchDragState.lastTarget = null;
    }
    document.querySelectorAll('.target-hover').forEach(el => el.classList.remove('target-hover'));
}

function handleTouchStart(e) {
    if (GameState.phase !== 'PLANNING') return;

    // Require touch start on an ability box to begin a drag
    const ab = e.target.closest('.ability-box');
    if (!ab) return;
    const abId = ab.id;
    const parentId = GameState.abilityTargets[abId];
    if (!parentId) return;
    const unit = GameState.units[parentId];
    if (!unit || unit.hp <= 0) return;

    // Prevent scrolling while dragging
    e.preventDefault();
    document.body.classList.add('dragging');

    touchDragState.srcId = parentId; // source unit id
    touchDragState.srcBoxId = abId; // visual source box id
    touchDragState.isDragging = true;

    const touch = e.touches[0];
    GameState.dragStart = getCenter(abId);
    GameState.dragCurrent = { x: touch.clientX, y: touch.clientY };
}

function handleTouchMove(e) {
    if (!touchDragState.isDragging || GameState.phase !== 'PLANNING') return;

    e.preventDefault(); // Prevent scrolling

    const touch = e.touches[0];
    // Keep arrow base synced with the source ability-box center (touch)
    if (touchDragState.srcBoxId) {
        const c = getCenter(touchDragState.srcBoxId);
        if (c) GameState.dragStart = c;
    }
    GameState.dragCurrent = { x: touch.clientX, y: touch.clientY };
    // Auto-scroll when dragging near viewport edges on touch
    autoScrollIfNeeded(touch.clientY);

    // Find element under touch point
    const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
    const targetCard = elementAtPoint?.closest('.unit-card');

    // Remove hover from previous target
    if (touchDragState.lastTarget && touchDragState.lastTarget !== targetCard) {
        touchDragState.lastTarget.classList.remove('target-hover');
        touchDragState.lastTarget = null;
    }

    // Add hover to current target if valid
    if (targetCard && targetCard.id !== touchDragState.srcId) {
        if (isValidDragTarget(touchDragState.srcId, targetCard.id)) {
            targetCard.classList.add('target-hover');
            touchDragState.lastTarget = targetCard;
        }
    }
}

function handleTouchEnd(e) {
    if (!touchDragState.isDragging || GameState.phase !== 'PLANNING') return;
    
    // Only prevent default if the event is cancelable to avoid warning
    if (e.cancelable) e.preventDefault();
    
    const touch = e.changedTouches[0];
    const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
    const abTarget = elementAtPoint?.closest('.ability-box');
    const tgtCard = elementAtPoint?.closest('.unit-card');

    if ((tgtCard || abTarget) && touchDragState.srcId) {
        const srcUnitId = touchDragState.srcId;
        const tgtVisualId = abTarget ? abTarget.id : tgtCard.id;

        if (isValidDragTarget(srcUnitId, tgtVisualId)) {
            GameState.pendingActions[srcUnitId] = { srcBoxId: touchDragState.srcBoxId || null, tgt: tgtVisualId };
            const srcCard = document.getElementById(srcUnitId);
            if (srcCard) srcCard.classList.add('assigned');
            // If this is a player attacking an enemy, make that enemy counter-target this PC (visual)
            const parentId = GameState.abilityTargets[tgtVisualId];
            const tgtUnit = GameState.units[parentId || tgtVisualId];
            if (tgtUnit && tgtUnit.type === 'EN') {
                try {
                    if (!GameState.enemyActions) GameState.enemyActions = {};
                    const enId = parentId || tgtVisualId;
                    const enBox = Object.keys(GameState.abilityTargets).find(k => GameState.abilityTargets[k] === enId);
                    const pcVisual = touchDragState.srcBoxId || srcUnitId;
                    GameState.enemyActions[enId] = { srcBoxId: enBox || enId, tgt: pcVisual };
                } catch (e) { console.error('set enemy counter error', e); }
            }
        }
    }
    // Reset state
    resetDragState();
}

// Cancel drag if touch is cancelled
function handleTouchCancel(e) {
    resetDragState();
}

// ==========================================
// 8. INIT
// ==========================================
function updateUI(id) {
    const u = GameState.units[id];
    const el = document.getElementById(id);
    if (!el || !u) return;
    const hpFill = el.querySelector('.hp-fill');
    const hpText = el.querySelector('.hp-text');
    if (hpFill) hpFill.style.width = `${(u.hp / u.maxHp) * 100}%`;
    if (hpText) hpText.innerText = `${u.hp}/${u.maxHp}`;
    // Update enemy prominent HP bar if present
    const eFill = el.querySelector('.enemy-hp-fill');
    const eText = el.querySelector('.enemy-hp-text');
    if (eFill) eFill.style.width = `${(u.hp / u.maxHp) * 100}%`;
    if (eText) eText.innerText = `${u.hp}/${u.maxHp}`;
    if(u.hp <= 0) { el.classList.add('opacity-50', 'grayscale'); el.draggable = false; }
}

function createCard(u, id) {
    const isPC = u.type === 'PC';
    const div = document.createElement('div');
    div.id = id;
    div.className = `unit-card relative h-40 sm:h-44 w-full rounded-xl border-b-4 shadow-lg flex flex-col p-2 sm:p-3 ${isPC ? 'border-blue-500 draggable' : 'border-red-500'} ${id === 'EN_Locus' ? 'mt-12' : ''}`;
    
    // Desktop drag and drop: dragging now originates from ability boxes, not the whole card
    div.ondrop = (e) => {
        e.preventDefault();
        // Check if it's a parameter being dropped
        if (GameState.parameterDragStart) {
            const param = GameState.parameterDragStart;
            
            // Only allow parameters on PC units
            if (u.type !== 'PC') {
                GameState.parameterDragStart = null;
                GameState.parameterDragSourceId = null;
                return;
            }
            
            if (!u.parameters) u.parameters = [];
            
            // Only allow 1 parameter per character
            if (u.parameters.length >= 1) {
                GameState.parameterDragStart = null;
                GameState.parameterDragSourceId = null;
                return;
            }
            
            // Check if this unit already has this parameter
            const alreadyHasParam = u.parameters.some(p => p.name === param.name);
            if (alreadyHasParam) {
                GameState.parameterDragStart = null;
                GameState.parameterDragSourceId = null;
                return;
            }
            
            // Remove this parameter from all other units
            Object.keys(GameState.units).forEach(unitId => {
                const unit = GameState.units[unitId];
                if (unitId !== id && unit.parameters) {
                    unit.parameters = unit.parameters.filter(p => p.name !== param.name);
                    updateParameterBadges(unitId);
                }
            });
            
            u.parameters.push(param);
            log(`${u.name} gained ${param.name}`, 'sys');
            updateParameterBadges(id);
            GameState.parameterDragStart = null;
            GameState.parameterDragSourceId = null;
        } else {
            handleDrop(e);
        }
    };
    div.ondragover = e => { 
        e.preventDefault(); 
        // Only show hover for PCs when dragging parameters
        if (GameState.parameterDragStart) {
            if (u.type === 'PC') div.classList.add('target-hover');
        } else if (GameState.phase === 'PLANNING') {
            div.classList.add('target-hover');
        }
    };
    div.ondragleave = e => div.classList.remove('target-hover');
    
    // Mobile touch events (for all cards - can be source or target)
    div.addEventListener('touchstart', handleTouchStart, { passive: false });
    div.addEventListener('touchmove', handleTouchMove, { passive: false });
    div.addEventListener('touchend', handleTouchEnd, { passive: false });
    div.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    // Badge Logic (only for player cards)
    let badge = "";
    if (isPC) {
        if (u.ability.type === 'Rolling') badge = `<span class="absolute top-1 right-1 px-1 py-0.5 bg-sky-600 text-[8px] sm:text-[10px] font-bold rounded text-white tracking-wider">ROLL (${u.ability.rolls})</span>`;
        if (u.ability.type === 'Ignore') badge = `<span class="absolute top-1 right-1 px-1 py-0.5 bg-purple-600 text-[8px] sm:text-[10px] font-bold rounded text-white tracking-wider">IGNORE</span>`;
        if (u.ability.heal > 0) badge = `<span class="absolute top-1 right-1 px-1 py-0.5 bg-emerald-600 text-[8px] sm:text-[10px] font-bold rounded text-white tracking-wider">HEAL (${u.ability.heal})</span>`;
        if (u.ability.effect === 'Sustain Protocol') badge = `<span class="absolute top-1 right-1 px-1 py-0.5 bg-blue-600 text-[8px] sm:text-[10px] font-bold rounded text-white tracking-wider">SUSTAIN</span>`;
    }

    const infoBtn = `<button class="info-btn" onclick="toggleInfo('${id}')">INFO</button>`;
    const passiveList = (Array.isArray(u.passives) && u.passives.length>0) ? u.passives.map(n=>`<div class='info-line'>• ${n}: ${PassiveDefinitions[n]?.desc || ''}</div>`).join('') : `<div class='info-line text-slate-500'>No passives</div>`;
    const infoPopup = (()=>{
        let abilityInfo = '';
        if (Array.isArray(u.abilities) && u.abilities.length > 0) {
            abilityInfo = u.abilities.map((ab, idx)=>{
                const label = `A${idx+1}`;
                return `<div class='info-line'><span class='font-bold text-slate-200'>${label}:</span> ${ab.type}${ab.rolls>0?` (Roll 0-${ab.rolls})`:''} • DMG ${ab.damage ?? 0}</div>`;
            }).join('');
        } else {
            abilityInfo = `<div class='info-line'><span class='font-bold text-slate-200'>A1:</span> ${u.ability.type}${u.ability.rolls>0?` (Roll 0-${u.ability.rolls})`:''} • DMG ${u.ability.damage ?? 0}</div>`;
        }
        return `
        <div id="${id}-info" class="info-popup hidden">
            <div class='info-title'>${u.baseName || u.name} Overview</div>
            ${abilityInfo}
            <div class='info-title mt-1'>Passives</div>
            ${passiveList}
        </div>`;
    })();

    // Icon HTML: support image paths or simple emoji/text
    let iconHtml = '';
    if (u.icon) {
        const isImg = /\.(png|jpe?g|gif|webp|svg)$|^https?:\/\//i.test(String(u.icon));
        if (isImg) {
            iconHtml = `<img src="${u.icon}" alt="${u.name || id}" class="w-full h-full object-cover">`;
        } else {
            const safe = String(u.icon).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            iconHtml = `<div class="text-xl sm:text-2xl">${safe}</div>`;
        }
    }

    // Ability boxes (square boxes A1, A2, ...) for both enemies and players
    const abilityBoxes = (()=>{ 
        let boxes = '';
        const abilities = Array.isArray(u.abilities) && u.abilities.length>0 ? u.abilities : [u.ability];
        abilities.forEach((ab, idx)=>{
            const abId = `${id}_AB_${idx}`;
            GameState.abilityTargets[abId]=id;
            boxes += `<div id='${abId}' class='ability-box text-xs text-slate-200'>A${idx+1}</div>`;
        });
        return boxes;
    })();

    div.innerHTML = `
        <div class="card-content">
        ${badge}
        ${infoBtn}
        <div class="flex justify-between text-xs font-bold ${isPC?'text-blue-400':'text-red-400'} uppercase mt-1">
            <span>${u.role || 'Enemy'}</span>
        </div>
        <div class="flex items-center gap-3">
            <div class="unit-icon">${iconHtml}</div>
            <div class="text-base sm:text-lg font-bold text-white">${u.name || id}</div>
        </div>
        ${infoPopup}
        ${!isPC ? `
        <div class='enemy-hp'>
            <div class='enemy-hp-fill bg-red-500' style='width:${(u.hp / u.maxHp) * 100}%; background-color: #ef4444;'></div>
            <div class='enemy-hp-text'>${u.hp}/${u.maxHp}</div>
        </div>
        <div class='mt-1'>
            <div class='flex gap-2 flex-wrap justify-center'>${abilityBoxes}</div>
        </div>` : ''}
        ${isPC ? `
        <div class='mt-1'>
            <div class='bg-slate-700 rounded-full h-1.5' style='background-color: #334155;'>
                <div class='hp-fill bg-blue-500 h-full rounded-full transition-all duration-300' style='width:${(u.hp / u.maxHp) * 100}%; background-color: #3b82f6;'></div>
            </div>
            <div class='hp-text text-xs text-blue-300 text-center mt-0.5' style='font-size: 10px;'>${u.hp}/${u.maxHp}</div>
        </div>
        <div class='flex gap-2 flex-wrap justify-center mb-1'>${abilityBoxes}</div>` : ''}
        </div>
    `;
    // Attach drag handlers to ability boxes inside this card so dragging must originate from boxes
    const boxes = div.querySelectorAll('.ability-box');
    boxes.forEach(box => {
        // Make player ability boxes draggable (sources). Enemy boxes should not be draggable by default.
        const abId = box.id;
        const parentId = GameState.abilityTargets[abId];
        if (!parentId) return;
        if (parentId.startsWith('PC_')) {
            box.draggable = true;
            box.ondragstart = function(ev) {
                // dataTransfer: 'unitId|abilityId'
                ev.dataTransfer.setData('text/plain', `${parentId}|${abId}`);
                ev.dataTransfer.setDragImage(new Image(), 0, 0);
                GameState.dragSourceId = abId;
                GameState.dragStart = getCenter(abId);
            };
        }
    });

    return div;
}

function updateParameterBadges(unitId) {
    const unit = GameState.units[unitId];
    const card = document.getElementById(unitId);
    if (!card) return;
    
    // Find or create parameter badges container
    let badgesContainer = card.querySelector('.parameter-badges');
    if (!badgesContainer) {
        badgesContainer = document.createElement('div');
        badgesContainer.className = 'parameter-badges text-xs flex flex-wrap gap-1 mt-1';
        card.querySelector('.card-content').appendChild(badgesContainer);
    }
    
    if (!unit.parameters || unit.parameters.length === 0) {
        badgesContainer.innerHTML = '';
    } else {
        badgesContainer.innerHTML = unit.parameters.map(p => 
            `<span class="bg-purple-600 text-white px-1 py-0.5 rounded text-[10px] font-bold">${p.name}</span>`
        ).join('');
    }
}

async function init() {
    // Fetch unit data and parameters from server first
    await Promise.all([
        fetchUnitData(1),
        fetchParameters()
    ]);
    
    const pCon = document.getElementById('player-container');
    const eCon = document.getElementById('enemy-container');
    
    // Create PC units from server data
    Object.entries(UnitData.PCs).forEach(([name, data], i) => {
        const id = `PC_${i}`;
        GameState.units[id] = { ...data, name, type: 'PC', hp: data.maxHp, id, parameters: [] };
        pCon.appendChild(createCard(GameState.units[id], id));
    });
    
    // Create enemy units from server data
    Object.entries(UnitData.ENs).forEach(([name, data], i) => {
        const id = `EN_${i}`;
        GameState.units[id] = { ...data, type: 'EN', hp: data.maxHp, id, baseName: data.name, parameters: [] };
        eCon.appendChild(createCard(GameState.units[id], id));
    });

    // Initialize parameters container
    initParametersPanel();

    // Start the game with the dialogue sequence (dialogue loader will call `startDialogue` when ready)
}

function initParametersPanel() {
    const container = document.getElementById('parameters-container');
    container.innerHTML = '';
    ParametersList.forEach(param => {
        const paramEl = document.createElement('div');
        paramEl.id = param.id;
        paramEl.draggable = true;
        paramEl.className = 'bg-slate-800 hover:bg-slate-700 p-3 rounded border border-slate-600 cursor-grab active:cursor-grabbing text-xs text-white transition-all';
        paramEl.innerHTML = `
            <div class="font-semibold text-amber-300">${param.name}</div>
            <div class="text-slate-400 text-[11px] mt-1">${param.desc}</div>
        `;
        
        // Desktop drag and drop
        paramEl.addEventListener('dragstart', (e) => {
            GameState.parameterDragStart = param;
            GameState.parameterDragSourceId = param.id;
            e.dataTransfer.effectAllowed = 'copy';
            paramEl.classList.add('opacity-50');
        });
        
        paramEl.addEventListener('dragend', () => {
            paramEl.classList.remove('opacity-50');
            GameState.parameterDragStart = null;
            GameState.parameterDragSourceId = null;
        });

        // Mobile touch drag
        let touchStartX = 0, touchStartY = 0;
        paramEl.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            GameState.parameterDragStart = param;
            GameState.parameterDragSourceId = param.id;
            paramEl.classList.add('opacity-50');
        });
        
        paramEl.addEventListener('touchend', (e) => {
            paramEl.classList.remove('opacity-50');
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const elementAtPoint = document.elementFromPoint(touchEndX, touchEndY);
            const targetCard = elementAtPoint?.closest('.unit-card');
            
            if (targetCard && GameState.parameterDragStart) {
                const unitId = targetCard.id;
                const unit = GameState.units[unitId];
                if (unit) {
                    // Only allow parameters on PC units
                    if (unit.type !== 'PC') {
                        GameState.parameterDragStart = null;
                        GameState.parameterDragSourceId = null;
                        return;
                    }
                    
                    if (!unit.parameters) unit.parameters = [];
                    
                    // Only allow 1 parameter per character
                    if (unit.parameters.length >= 1) {
                        GameState.parameterDragStart = null;
                        GameState.parameterDragSourceId = null;
                        return;
                    }
                    
                    // Check if this unit already has this parameter
                    const alreadyHasParam = unit.parameters.some(p => p.name === param.name);
                    if (!alreadyHasParam) {
                        // Remove this parameter from all other units
                        Object.keys(GameState.units).forEach(otherUnitId => {
                            const otherUnit = GameState.units[otherUnitId];
                            if (otherUnitId !== unitId && otherUnit.parameters) {
                                otherUnit.parameters = otherUnit.parameters.filter(p => p.name !== param.name);
                                updateParameterBadges(otherUnitId);
                            }
                        });
                        
                        unit.parameters.push(param);
                        log(`${unit.name} gained ${param.name}`, 'sys');
                        updateParameterBadges(unitId);
                    }
                }
            }
            GameState.parameterDragStart = null;
            GameState.parameterDragSourceId = null;
        });
        
        container.appendChild(paramEl);
    });
}

window.onload = init;

// Toggle enemy info popup
window.toggleInfo = function(id) {
    const el = document.getElementById(`${id}-info`);
    if (!el) return;
    el.classList.toggle('hidden');
};

// Mobile control panel toggle: show/hide control panel as an overlay on small screens
window.toggleControlsOverlay = function() {
    const btn = document.getElementById('controls-toggle');
    const panel = document.getElementById('control-panel');
    if (!panel || !btn) return;
    const isClosed = panel.classList.contains('panel-closed');
    if (isClosed) {
        panel.classList.remove('panel-closed');
        btn.innerText = '✕';
    } else {
        panel.classList.add('panel-closed');
        btn.innerText = '☰';
    }
};

// Small visual feedback for the toggle button when clicked
document.getElementById('controls-toggle').addEventListener('click', function() {
    const b = this;
    b.classList.add('btn-animate');
    setTimeout(() => b.classList.remove('btn-animate'), 220);
});
