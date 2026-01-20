// ==========================================
// SERVER-SIDE COMBAT ENGINE
// ==========================================

import { ObjectId, Db } from 'mongodb';

// Status Effect Definitions
export const StatusEffectDefinitions: Record<string, {
    desc: string;
    stackable: boolean;
    maxStacks: number;
}> = {
    "Bleed": { desc: "Takes damage based on roll difference when hit", stackable: true, maxStacks: 5 },
    "Poison": { desc: "Takes damage at turn start, decreases each turn", stackable: true, maxStacks: 10 },
    "Rupture": { desc: "Every N damage taken triggers X bonus damage", stackable: true, maxStacks: 3 },
    "Burn": { desc: "Takes fire damage at turn end", stackable: true, maxStacks: 5 },
    "Weaken": { desc: "Deals reduced damage", stackable: true, maxStacks: 3 },
    "Vulnerable": { desc: "Takes increased damage", stackable: true, maxStacks: 3 }
};

// Passive Definitions
export const PassiveDefinitions: Record<string, { desc: string; func: string }> = {
    "Aero-Mesh": { desc: "Takes 2 less damage from Rolling attacks", func: "aeroMesh" },
    "Slag Armor": { desc: "Takes 3 less damage from all attacks", func: "slagArmor" },
    "Nano-Repair": { desc: "Heals 15 HP at end of turn", func: "nanoRepair" },
    "Turbo Thrusters": { desc: "Acts before players regardless of speed", func: "turboThrusters" }
};

// Types
export interface CombatAbility {
    name?: string;
    damage: number;
    heal: number;
    minroll: number;
    rolls: number;
    type: string;
    effect?: string;
}

export interface CombatUnit {
    id: string;
    name: string;
    type: 'PC' | 'EN';
    maxHp: number;
    hp: number;
    role?: string;
    level?: number;
    speed?: number;
    ability: CombatAbility;
    abilities: CombatAbility[];
    passives: string[];
    statusEffects: Record<string, number>;
    ruptureDamageAccum?: number;
}

export interface CombatAction {
    sourceId: string;
    sourceAbilityIndex: number;
    targetId: string;
    targetAbilityIndex?: number;
}

export interface CombatEvent {
    type: 'roll' | 'damage' | 'heal' | 'status' | 'death' | 'duel' | 'message' | 'turn_start' | 'turn_end' | 'phase_change' | 'speed_roll' | 'victory' | 'defeat';
    sourceId?: string;
    targetId?: string;
    value?: number;
    roll1?: number;
    roll2?: number;
    winner?: string;
    message: string;
    messageType?: 'def' | 'dmg' | 'heal' | 'sys' | 'duel' | 'tie' | 'tank';
    statusEffect?: string;
    stacks?: number;
}

export interface CombatSession {
    _id?: ObjectId;
    sessionId: string;
    username: string;
    chapter: number;
    level: number;
    units: Record<string, CombatUnit>;
    phase: 'PLANNING' | 'EXECUTING' | 'VICTORY' | 'DEFEAT';
    turn: number;
    turnOrder: string[];
    enemyActions: Record<string, CombatAction>;
    pendingActions: Record<string, CombatAction>;
    events: CombatEvent[];
    createdAt: Date;
    updatedAt: Date;
    // WebSocket connection tracking
    isConnected: boolean;
    lastDisconnect: Date | null;
}

// In-memory cache for active sessions (backed by MongoDB)
const sessionCache: Map<string, CombatSession> = new Map();

// MongoDB database reference (set by initCombatSessionDB)
let combatDb: Db | null = null;

// Initialize MongoDB for combat sessions
export function initCombatSessionDB(db: Db): void {
    combatDb = db;
    console.log('Combat session DB initialized');
    
    // Create index for sessionId and username
    db.collection('combat_sessions').createIndex({ sessionId: 1 }, { unique: true });
    db.collection('combat_sessions').createIndex({ username: 1 });
    db.collection('combat_sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // 24 hour TTL
}

// Generate unique session ID
function generateSessionId(): string {
    return `combat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Dice rolling utilities
function rollD20(): number {
    return 1 + Math.floor(Math.random() * 20);
}

function rollInRange(min: number, max: number): number {
    if (min >= max) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
}

// Generate unique speeds for units
function generateUniqueSpeeds(unitIds: string[]): Record<string, number> {
    const speeds: Record<string, number> = {};
    
    // Initial rolls
    unitIds.forEach(id => speeds[id] = rollD20());
    
    // Resolve ties
    function findDuplicates(): string[][] {
        const rev: Record<number, string[]> = {};
        Object.entries(speeds).forEach(([id, v]) => {
            rev[v] = rev[v] || [];
            rev[v].push(id);
        });
        return Object.values(rev).filter(arr => arr.length > 1);
    }
    
    let dups = findDuplicates();
    while (dups.length > 0) {
        dups.forEach(group => {
            group.forEach(id => { speeds[id] = rollD20(); });
        });
        dups = findDuplicates();
    }
    
    return speeds;
}

// Status Effect Functions
const StatusEffectFunctions = {
    applyBleed: (unit: CombatUnit, stacks: number, rollDiff: number = 0): { damage: number; message: string } | null => {
        if (!unit || unit.hp <= 0 || stacks <= 0) return null;
        const bleedDmg = Math.floor((1 + Math.floor(rollDiff / 3)) * stacks);
        if (bleedDmg > 0) {
            unit.hp = Math.max(0, unit.hp - bleedDmg);
            return { damage: bleedDmg, message: `${unit.name} bleeds for ${bleedDmg} damage!` };
        }
        return null;
    },
    
    tickPoison: (unit: CombatUnit): { damage: number; message: string } | null => {
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Poison) return null;
        const stacks = unit.statusEffects.Poison;
        const poisonDmg = stacks;
        if (poisonDmg > 0) {
            unit.hp = Math.max(0, unit.hp - poisonDmg);
            unit.statusEffects.Poison = Math.max(0, stacks - 1);
            if (unit.statusEffects.Poison <= 0) delete unit.statusEffects.Poison;
            return { damage: poisonDmg, message: `${unit.name} takes ${poisonDmg} poison damage!` };
        }
        return null;
    },
    
    checkRupture: (unit: CombatUnit, damageDealt: number): { damage: number; message: string } | null => {
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Rupture) return null;
        const stacks = unit.statusEffects.Rupture;
        if (!unit.ruptureDamageAccum) unit.ruptureDamageAccum = 0;
        unit.ruptureDamageAccum += damageDealt;
        const threshold = 5;
        let totalRuptureDmg = 0;
        while (unit.ruptureDamageAccum >= threshold) {
            unit.ruptureDamageAccum -= threshold;
            const ruptureDmg = 2 * stacks;
            unit.hp = Math.max(0, unit.hp - ruptureDmg);
            totalRuptureDmg += ruptureDmg;
        }
        if (totalRuptureDmg > 0) {
            return { damage: totalRuptureDmg, message: `${unit.name} ruptures for ${totalRuptureDmg} damage!` };
        }
        return null;
    },
    
    tickBurn: (unit: CombatUnit): { damage: number; message: string } | null => {
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Burn) return null;
        const stacks = unit.statusEffects.Burn;
        const burnDmg = stacks;
        if (burnDmg > 0) {
            unit.hp = Math.max(0, unit.hp - burnDmg);
            unit.statusEffects.Burn = Math.max(0, stacks - 1);
            if (unit.statusEffects.Burn <= 0) delete unit.statusEffects.Burn;
            return { damage: burnDmg, message: `${unit.name} burns for ${burnDmg} damage!` };
        }
        return null;
    },
    
    tickBleed: (unit: CombatUnit): void => {
        if (!unit || unit.hp <= 0 || !unit.statusEffects?.Bleed) return;
        unit.statusEffects.Bleed = Math.max(0, unit.statusEffects.Bleed - 1);
        if (unit.statusEffects.Bleed <= 0) delete unit.statusEffects.Bleed;
    },
    
    getWeakenMultiplier: (unit: CombatUnit): number => {
        if (!unit || !unit.statusEffects?.Weaken) return 1;
        const stacks = unit.statusEffects.Weaken;
        return Math.max(0.4, 1 - (stacks * 0.15));
    },
    
    getVulnerableMultiplier: (unit: CombatUnit): number => {
        if (!unit || !unit.statusEffects?.Vulnerable) return 1;
        const stacks = unit.statusEffects.Vulnerable;
        return 1 + (stacks * 0.2);
    }
};

// Passive effect functions
const PassiveFunctions = {
    aeroMesh: (damage: number, attackType: string): number => {
        if (attackType === 'Rolling') {
            return Math.max(0, damage - 2);
        }
        return damage;
    },
    
    slagArmor: (damage: number): number => {
        return Math.max(0, damage - 3);
    },
    
    nanoRepair: (unit: CombatUnit): { heal: number; message: string } | null => {
        if (!unit || unit.hp <= 0) return null;
        const healAmt = 15;
        unit.hp = Math.min(unit.maxHp, unit.hp + healAmt);
        return { heal: healAmt, message: `${unit.name} repairs ${healAmt} HP (Nano-Repair).` };
    }
};

// Apply damage with passive considerations
function applyDamageWithPassives(
    attacker: CombatUnit,
    defender: CombatUnit,
    baseDamage: number,
    attackType: string
): { finalDamage: number; events: CombatEvent[] } {
    const events: CombatEvent[] = [];
    let damage = baseDamage;
    
    // Apply attacker's weaken debuff
    damage = Math.floor(damage * StatusEffectFunctions.getWeakenMultiplier(attacker));
    
    // Apply defender's vulnerable debuff
    damage = Math.floor(damage * StatusEffectFunctions.getVulnerableMultiplier(defender));
    
    // Apply defender passives
    if (defender.passives.includes('Aero-Mesh') && attackType === 'Rolling') {
        const oldDmg = damage;
        damage = PassiveFunctions.aeroMesh(damage, attackType);
        if (oldDmg !== damage) {
            events.push({
                type: 'message',
                targetId: defender.id,
                message: `${defender.name}'s Aero-Mesh reduces damage by 2!`,
                messageType: 'sys'
            });
        }
    }
    
    if (defender.passives.includes('Slag Armor')) {
        const oldDmg = damage;
        damage = PassiveFunctions.slagArmor(damage);
        if (oldDmg !== damage) {
            events.push({
                type: 'message',
                targetId: defender.id,
                message: `${defender.name}'s Slag Armor reduces damage by 3!`,
                messageType: 'sys'
            });
        }
    }
    
    // Apply damage
    defender.hp = Math.max(0, defender.hp - damage);
    
    events.push({
        type: 'damage',
        sourceId: attacker.id,
        targetId: defender.id,
        value: damage,
        message: `${attacker.name} deals ${damage} damage to ${defender.name}!`,
        messageType: 'dmg'
    });
    
    // Check rupture
    const ruptureResult = StatusEffectFunctions.checkRupture(defender, damage);
    if (ruptureResult) {
        events.push({
            type: 'damage',
            targetId: defender.id,
            value: ruptureResult.damage,
            message: ruptureResult.message,
            messageType: 'dmg'
        });
    }
    
    // Check for death
    if (defender.hp <= 0) {
        events.push({
            type: 'death',
            targetId: defender.id,
            message: `${defender.name} has been defeated!`,
            messageType: 'sys'
        });
    }
    
    return { finalDamage: damage, events };
}

// Add status effect to unit
function addStatusEffect(unit: CombatUnit, effectName: string, stacks: number): CombatEvent | null {
    const def = StatusEffectDefinitions[effectName];
    if (!def || !unit || unit.hp <= 0) return null;
    
    if (!unit.statusEffects) unit.statusEffects = {};
    
    if (def.stackable) {
        unit.statusEffects[effectName] = Math.min(
            (unit.statusEffects[effectName] || 0) + stacks,
            def.maxStacks
        );
    } else {
        unit.statusEffects[effectName] = stacks;
    }
    
    return {
        type: 'status',
        targetId: unit.id,
        statusEffect: effectName,
        stacks: unit.statusEffects[effectName],
        message: `${unit.name} gains ${effectName} (${unit.statusEffects[effectName]} stacks)!`,
        messageType: 'sys'
    };
}

// Combat Engine Class
export class CombatEngine {
    private session: CombatSession;
    
    constructor(session: CombatSession) {
        this.session = session;
    }
    
    // Get all living PCs
    private getLivingPCs(): CombatUnit[] {
        return Object.values(this.session.units).filter(u => u.type === 'PC' && u.hp > 0);
    }
    
    // Get all living enemies
    private getLivingEnemies(): CombatUnit[] {
        return Object.values(this.session.units).filter(u => u.type === 'EN' && u.hp > 0);
    }
    
    // Check win/loss conditions
    checkWinLoss(): 'victory' | 'defeat' | null {
        const pcs = this.getLivingPCs();
        const enemies = this.getLivingEnemies();
        
        if (enemies.length === 0) return 'victory';
        if (pcs.length === 0) return 'defeat';
        return null;
    }
    
    // Roll speeds and determine turn order
    rollSpeeds(): CombatEvent[] {
        const events: CombatEvent[] = [];
        const pcIds = this.getLivingPCs().map(u => u.id);
        
        if (pcIds.length === 0) return events;
        
        const speeds = generateUniqueSpeeds(pcIds);
        
        // Apply speeds to units
        Object.entries(speeds).forEach(([id, speed]) => {
            if (this.session.units[id]) {
                this.session.units[id].speed = speed;
            }
        });
        
        // Determine turn order (descending speed)
        this.session.turnOrder = pcIds.sort((a, b) => 
            (this.session.units[b]?.speed || 0) - (this.session.units[a]?.speed || 0)
        );
        
        const speedParts = this.session.turnOrder.map(id => 
            `${this.session.units[id]?.name || id}(${speeds[id]})`
        );
        
        events.push({
            type: 'speed_roll',
            message: `Speed rolls: ${speedParts.join(' • ')}`,
            messageType: 'sys'
        });
        
        events.push({
            type: 'message',
            message: `Turn order: ${this.session.turnOrder.map(id => this.session.units[id]?.name || id).join(' → ')}`,
            messageType: 'sys'
        });
        
        return events;
    }
    
    // Process turn start effects (poison)
    processTurnStart(): CombatEvent[] {
        const events: CombatEvent[] = [];
        
        events.push({
            type: 'turn_start',
            message: `Turn ${this.session.turn} begins!`,
            messageType: 'sys'
        });
        
        Object.values(this.session.units).forEach(unit => {
            if (unit.hp > 0) {
                const poisonResult = StatusEffectFunctions.tickPoison(unit);
                if (poisonResult) {
                    events.push({
                        type: 'damage',
                        targetId: unit.id,
                        value: poisonResult.damage,
                        message: poisonResult.message,
                        messageType: 'dmg'
                    });
                    if (unit.hp <= 0) {
                        events.push({
                            type: 'death',
                            targetId: unit.id,
                            message: `${unit.name} has been defeated!`,
                            messageType: 'sys'
                        });
                    }
                }
            }
        });
        
        return events;
    }
    
    // Process turn end effects (burn, bleed, nano-repair)
    processTurnEnd(): CombatEvent[] {
        const events: CombatEvent[] = [];
        
        Object.values(this.session.units).forEach(unit => {
            if (unit.hp > 0) {
                // Burn damage
                const burnResult = StatusEffectFunctions.tickBurn(unit);
                if (burnResult) {
                    events.push({
                        type: 'damage',
                        targetId: unit.id,
                        value: burnResult.damage,
                        message: burnResult.message,
                        messageType: 'dmg'
                    });
                }
                
                // Tick bleed (reduce stacks)
                StatusEffectFunctions.tickBleed(unit);
                
                // Nano-Repair passive
                if (unit.passives.includes('Nano-Repair')) {
                    const repairResult = PassiveFunctions.nanoRepair(unit);
                    if (repairResult) {
                        events.push({
                            type: 'heal',
                            targetId: unit.id,
                            value: repairResult.heal,
                            message: repairResult.message,
                            messageType: 'heal'
                        });
                    }
                }
                
                // Check death
                if (unit.hp <= 0) {
                    events.push({
                        type: 'death',
                        targetId: unit.id,
                        message: `${unit.name} has been defeated!`,
                        messageType: 'sys'
                    });
                }
            }
        });
        
        events.push({
            type: 'turn_end',
            message: `Turn ${this.session.turn} ends.`,
            messageType: 'sys'
        });
        
        return events;
    }
    
    // Resolve a duel between PC and enemy
    resolveDuel(pcId: string, enemyId: string, pcAbilityIndex: number = 0, enemyAbilityIndex: number = 0): CombatEvent[] {
        const events: CombatEvent[] = [];
        const pc = this.session.units[pcId];
        const enemy = this.session.units[enemyId];
        
        if (!pc || pc.hp <= 0 || !enemy || enemy.hp <= 0) {
            events.push({
                type: 'message',
                message: 'Engagement canceled: unit down.',
                messageType: 'sys'
            });
            return events;
        }
        
        const pcAbility = pc.abilities[pcAbilityIndex] || pc.ability;
        const enemyAbility = enemy.abilities[enemyAbilityIndex] || enemy.ability;
        
        const isRollingEnemy = enemyAbility.type === 'Rolling';
        
        if (isRollingEnemy) {
            // Rolling duel - both sides roll dice
            const pcMin = pcAbility.minroll ?? 0;
            const pcMax = pcAbility.rolls ?? 0;
            const enMin = enemyAbility.minroll ?? 0;
            const enMax = enemyAbility.rolls ?? 0;
            
            const pcRoll = rollInRange(pcMin, pcMax);
            const enRoll = rollInRange(enMin, enMax);
            
            events.push({
                type: 'roll',
                sourceId: pcId,
                targetId: enemyId,
                roll1: pcRoll,
                roll2: enRoll,
                message: `${pc.name} rolls ${pcRoll} vs ${enemy.name}'s ${enRoll}`,
                messageType: 'duel'
            });
            
            if (pcRoll > enRoll) {
                // PC wins
                const rollDiff = pcRoll - enRoll;
                events.push({
                    type: 'duel',
                    sourceId: pcId,
                    targetId: enemyId,
                    winner: pcId,
                    message: `Duel: ${pc.name} (${pcRoll}) > ${enemy.name} (${enRoll}).`,
                    messageType: 'duel'
                });
                
                const damageResult = applyDamageWithPassives(pc, enemy, pcAbility.damage, 'Rolling');
                events.push(...damageResult.events);
                
                // Apply bleed if enemy has bleed stacks
                if (enemy.statusEffects?.Bleed) {
                    const bleedResult = StatusEffectFunctions.applyBleed(enemy, enemy.statusEffects.Bleed, rollDiff);
                    if (bleedResult) {
                        events.push({
                            type: 'damage',
                            targetId: enemyId,
                            value: bleedResult.damage,
                            message: bleedResult.message,
                            messageType: 'dmg'
                        });
                    }
                }
                
                // Sustain Protocol healing
                if (pcAbility.effect === 'Sustain Protocol') {
                    const healAmt = 5;
                    pc.hp = Math.min(pc.maxHp, pc.hp + healAmt);
                    events.push({
                        type: 'heal',
                        sourceId: pcId,
                        targetId: pcId,
                        value: healAmt,
                        message: `${pc.name} activates Sustain Protocol, restoring ${healAmt} HP.`,
                        messageType: 'tank'
                    });
                }
                
            } else if (pcRoll < enRoll) {
                // Enemy wins - PC takes damage
                const rollDiff = enRoll - pcRoll;
                events.push({
                    type: 'duel',
                    sourceId: enemyId,
                    targetId: pcId,
                    winner: enemyId,
                    message: `Duel: ${pc.name} (${pcRoll}) < ${enemy.name} (${enRoll}). Countered!`,
                    messageType: 'dmg'
                });
                
                const damageResult = applyDamageWithPassives(enemy, pc, enemyAbility.damage, 'Rolling');
                events.push(...damageResult.events);
                
                // Apply bleed if PC has bleed stacks
                if (pc.statusEffects?.Bleed) {
                    const bleedResult = StatusEffectFunctions.applyBleed(pc, pc.statusEffects.Bleed, rollDiff);
                    if (bleedResult) {
                        events.push({
                            type: 'damage',
                            targetId: pcId,
                            value: bleedResult.damage,
                            message: bleedResult.message,
                            messageType: 'dmg'
                        });
                    }
                }
                
            } else {
                // Tie - both take damage
                events.push({
                    type: 'duel',
                    sourceId: pcId,
                    targetId: enemyId,
                    message: `Duel Tied (${pcRoll}). Both take damage.`,
                    messageType: 'tie'
                });
                
                const pcDamageResult = applyDamageWithPassives(pc, enemy, pcAbility.damage, 'Rolling');
                events.push(...pcDamageResult.events);
                
                const enDamageResult = applyDamageWithPassives(enemy, pc, enemyAbility.damage, 'Rolling');
                events.push(...enDamageResult.events);
                
                // Chain Strike logic
                if (pcAbility.effect === 'Chain Strike') {
                    const chainEvents = this.handleChainStrike(pcId, enemyId);
                    events.push(...chainEvents);
                }
                
                // Sustain Protocol on tie (PC hit)
                if (pcAbility.effect === 'Sustain Protocol') {
                    const healAmt = 5;
                    pc.hp = Math.min(pc.maxHp, pc.hp + healAmt);
                    events.push({
                        type: 'heal',
                        sourceId: pcId,
                        targetId: pcId,
                        value: healAmt,
                        message: `${pc.name} activates Sustain Protocol, restoring ${healAmt} HP.`,
                        messageType: 'tank'
                    });
                }
            }
        } else {
            // Ignore target - guaranteed trade
            events.push({
                type: 'message',
                message: `${pc.name} engages Ignore unit ${enemy.name}. Trading damage.`,
                messageType: 'tie'
            });
            
            const pcDamageResult = applyDamageWithPassives(pc, enemy, pcAbility.damage, 'Ignore');
            events.push(...pcDamageResult.events);
            
            const enDamageResult = applyDamageWithPassives(enemy, pc, enemyAbility.damage, 'Ignore');
            events.push(...enDamageResult.events);
            
            // Chain Strike logic
            if (pcAbility.effect === 'Chain Strike') {
                const chainEvents = this.handleChainStrike(pcId, enemyId);
                events.push(...chainEvents);
            }
            
            // Sustain Protocol (guaranteed hit)
            if (pcAbility.effect === 'Sustain Protocol') {
                const healAmt = 5;
                pc.hp = Math.min(pc.maxHp, pc.hp + healAmt);
                events.push({
                    type: 'heal',
                    sourceId: pcId,
                    targetId: pcId,
                    value: healAmt,
                    message: `${pc.name} activates Sustain Protocol, restoring ${healAmt} HP.`,
                    messageType: 'tank'
                });
            }
        }
        
        return events;
    }
    
    // Handle Chain Strike ability
    handleChainStrike(srcId: string, originalTargetId: string): CombatEvent[] {
        const events: CombatEvent[] = [];
        const src = this.session.units[srcId];
        if (!src) return events;
        
        const otherEnemies = this.getLivingEnemies().filter(e => e.id !== originalTargetId);
        if (otherEnemies.length > 0) {
            const jumpTarget = otherEnemies[Math.floor(Math.random() * otherEnemies.length)];
            if (!jumpTarget) return events;
            
            const chainDmg = 6;
            jumpTarget.hp = Math.max(0, jumpTarget.hp - chainDmg);
            
            events.push({
                type: 'damage',
                sourceId: srcId,
                targetId: jumpTarget.id,
                value: chainDmg,
                message: `${src.name} Chain Strike jumped to ${jumpTarget.name} for ${chainDmg} damage!`,
                messageType: 'sys'
            });
            
            if (jumpTarget.hp <= 0) {
                events.push({
                    type: 'death',
                    targetId: jumpTarget.id,
                    message: `${jumpTarget.name} has been defeated!`,
                    messageType: 'sys'
                });
            }
        }
        
        return events;
    }
    
    // Handle healing action
    resolveHeal(srcId: string, targetId: string, abilityIndex: number = 0): CombatEvent[] {
        const events: CombatEvent[] = [];
        const src = this.session.units[srcId];
        const target = this.session.units[targetId];
        
        if (!src || src.hp <= 0 || !target || target.hp <= 0) {
            events.push({
                type: 'message',
                message: 'Healing canceled: unit down.',
                messageType: 'sys'
            });
            return events;
        }
        
        const ability = src.abilities[abilityIndex] || src.ability;
        const healAmt = ability.heal || 0;
        
        if (healAmt > 0) {
            target.hp = Math.min(target.maxHp, target.hp + healAmt);
            events.push({
                type: 'heal',
                sourceId: srcId,
                targetId: targetId,
                value: healAmt,
                message: `${src.name} heals ${target.name} for ${healAmt}.`,
                messageType: 'heal'
            });
        }
        
        return events;
    }
    
    // Resolve Turbo Thrusters enemies (act before players)
    resolveTurboThrusters(): CombatEvent[] {
        const events: CombatEvent[] = [];
        
        const turboEnemies = this.getLivingEnemies().filter(e => 
            e.passives.includes('Turbo Thrusters')
        );
        
        if (turboEnemies.length === 0) return events;
        
        events.push({
            type: 'message',
            message: '--- Turbo Thrusters engage (enemy priority) ---',
            messageType: 'sys'
        });
        
        const pcs = this.getLivingPCs();
        
        for (const enemy of turboEnemies) {
            if (enemy.hp <= 0) continue;
            
            for (let i = 0; i < enemy.abilities.length; i++) {
                const ability = enemy.abilities[i];
                if (!ability) continue;
                
                // Find target (prefer planned, otherwise random PC)
                let targetId: string | null = null;
                const planned = this.session.enemyActions[`${enemy.id}_AB_${i}`];
                if (planned && this.session.units[planned.targetId]?.hp && this.session.units[planned.targetId]!.hp > 0) {
                    targetId = planned.targetId;
                }
                
                if (!targetId && pcs.length > 0) {
                    const randomPc = pcs[Math.floor(Math.random() * pcs.length)];
                    if (randomPc) targetId = randomPc.id;
                }
                
                if (!targetId) continue;
                
                const target = this.session.units[targetId];
                if (!target || target.hp <= 0) continue;
                
                const damageResult = applyDamageWithPassives(enemy, target, ability.damage, ability.type);
                events.push(...damageResult.events);
                
                events.push({
                    type: 'message',
                    message: `${enemy.name} (${ability.name || 'A' + (i + 1)}) priority hit on ${target.name}.`,
                    messageType: 'dmg'
                });
            }
        }
        
        return events;
    }
    
    // Resolve unengaged enemy abilities
    resolveUnengagedEnemies(engagedAbilities: Set<string>): CombatEvent[] {
        const events: CombatEvent[] = [];
        
        // Find unengaged enemy ability boxes
        const enemies = this.getLivingEnemies();
        const unengagedActions: { enemyId: string; abilityIndex: number }[] = [];
        
        for (const enemy of enemies) {
            for (let i = 0; i < enemy.abilities.length; i++) {
                const boxId = `${enemy.id}_AB_${i}`;
                if (!engagedAbilities.has(boxId)) {
                    unengagedActions.push({ enemyId: enemy.id, abilityIndex: i });
                }
            }
        }
        
        if (unengagedActions.length === 0) return events;
        
        events.push({
            type: 'message',
            message: '--- Unengaged Enemy Abilities Attacking ---',
            messageType: 'sys'
        });
        
        const pcs = this.getLivingPCs();
        
        for (const action of unengagedActions) {
            const enemy = this.session.units[action.enemyId];
            if (!enemy || enemy.hp <= 0) continue;
            
            const ability = enemy.abilities[action.abilityIndex];
            if (!ability) continue;
            
            // Find target
            let targetId: string | null = null;
            const planned = this.session.enemyActions[`${enemy.id}_AB_${action.abilityIndex}`];
            if (planned && this.session.units[planned.targetId]?.hp && this.session.units[planned.targetId]!.hp > 0) {
                targetId = planned.targetId;
            }
            
            if (!targetId && pcs.length > 0) {
                const livingPCs = pcs.filter(p => p.hp > 0);
                if (livingPCs.length > 0) {
                    const randomPc = livingPCs[Math.floor(Math.random() * livingPCs.length)];
                    if (randomPc) targetId = randomPc.id;
                }
            }
            
            if (!targetId) continue;
            
            const target = this.session.units[targetId];
            if (!target || target.hp <= 0) continue;
            
            const damageResult = applyDamageWithPassives(enemy, target, ability.damage, ability.type);
            events.push(...damageResult.events);
            
            events.push({
                type: 'message',
                message: `${enemy.name} (${ability.name || 'A' + (action.abilityIndex + 1)}) free hit on ${target.name}.`,
                messageType: 'dmg'
            });
            
            // Check for victory/defeat after each enemy action
            const result = this.checkWinLoss();
            if (result) break;
        }
        
        return events;
    }
    
    // Execute a full combat turn
    executeTurn(playerActions: Record<string, CombatAction>): CombatEvent[] {
        const allEvents: CombatEvent[] = [];
        
        this.session.phase = 'EXECUTING';
        allEvents.push({
            type: 'phase_change',
            message: 'COMBAT PHASE',
            messageType: 'sys'
        });
        
        // Turn start effects (poison)
        const turnStartEvents = this.processTurnStart();
        allEvents.push(...turnStartEvents);
        
        let result = this.checkWinLoss();
        if (result) {
            allEvents.push({
                type: result === 'victory' ? 'victory' : 'defeat',
                message: result === 'victory' ? 'Victory!' : 'Defeat!',
                messageType: 'sys'
            });
            this.session.phase = result === 'victory' ? 'VICTORY' : 'DEFEAT';
            return allEvents;
        }
        
        // Turbo Thrusters enemies go first
        const turboEvents = this.resolveTurboThrusters();
        allEvents.push(...turboEvents);
        
        result = this.checkWinLoss();
        if (result) {
            allEvents.push({
                type: result === 'victory' ? 'victory' : 'defeat',
                message: result === 'victory' ? 'Victory!' : 'Defeat!',
                messageType: 'sys'
            });
            this.session.phase = result === 'victory' ? 'VICTORY' : 'DEFEAT';
            return allEvents;
        }
        
        // Track which enemy abilities were engaged
        const engagedEnemyAbilities = new Set<string>();
        
        // Process player actions in turn order
        for (const pcId of this.session.turnOrder) {
            const action = playerActions[pcId];
            if (!action) continue;
            
            const pc = this.session.units[pcId];
            const target = this.session.units[action.targetId];
            
            if (!pc || pc.hp <= 0) {
                allEvents.push({
                    type: 'message',
                    message: `${pc?.name || pcId} is down. Skipping order.`,
                    messageType: 'sys'
                });
                continue;
            }
            
            if (!target || target.hp <= 0) {
                allEvents.push({
                    type: 'message',
                    message: `${target?.name || 'Target'} already destroyed. Skipping order.`,
                    messageType: 'sys'
                });
                continue;
            }
            
            // Mark the enemy ability as engaged
            if (target.type === 'EN' && action.targetAbilityIndex !== undefined) {
                engagedEnemyAbilities.add(`${action.targetId}_AB_${action.targetAbilityIndex}`);
            }
            
            // Execute action
            if (target.type === 'EN' && pc.ability.damage > 0) {
                const duelEvents = this.resolveDuel(pcId, action.targetId, action.sourceAbilityIndex, action.targetAbilityIndex);
                allEvents.push(...duelEvents);
            } else if (target.type === 'PC' && pc.ability.heal > 0) {
                const healEvents = this.resolveHeal(pcId, action.targetId, action.sourceAbilityIndex);
                allEvents.push(...healEvents);
            }
            
            result = this.checkWinLoss();
            if (result) {
                allEvents.push({
                    type: result === 'victory' ? 'victory' : 'defeat',
                    message: result === 'victory' ? 'Victory!' : 'Defeat!',
                    messageType: 'sys'
                });
                this.session.phase = result === 'victory' ? 'VICTORY' : 'DEFEAT';
                return allEvents;
            }
        }
        
        // Unengaged enemies attack
        const unengagedEvents = this.resolveUnengagedEnemies(engagedEnemyAbilities);
        allEvents.push(...unengagedEvents);
        
        result = this.checkWinLoss();
        if (result) {
            allEvents.push({
                type: result === 'victory' ? 'victory' : 'defeat',
                message: result === 'victory' ? 'Victory!' : 'Defeat!',
                messageType: 'sys'
            });
            this.session.phase = result === 'victory' ? 'VICTORY' : 'DEFEAT';
            return allEvents;
        }
        
        // Turn end effects (burn, bleed, nano-repair)
        const turnEndEvents = this.processTurnEnd();
        allEvents.push(...turnEndEvents);
        
        result = this.checkWinLoss();
        if (result) {
            allEvents.push({
                type: result === 'victory' ? 'victory' : 'defeat',
                message: result === 'victory' ? 'Victory!' : 'Defeat!',
                messageType: 'sys'
            });
            this.session.phase = result === 'victory' ? 'VICTORY' : 'DEFEAT';
            return allEvents;
        }
        
        // Advance to next turn
        this.session.turn++;
        this.session.phase = 'PLANNING';
        
        // Roll new speeds
        const speedEvents = this.rollSpeeds();
        allEvents.push(...speedEvents);
        
        // Compute new enemy plans
        this.computeEnemyPlans();
        
        allEvents.push({
            type: 'phase_change',
            message: 'PLANNING PHASE',
            messageType: 'sys'
        });
        
        return allEvents;
    }
    
    // Compute planned enemy actions
    computeEnemyPlans(): void {
        const enemies = this.getLivingEnemies();
        const pcs = this.getLivingPCs();
        
        if (enemies.length === 0 || pcs.length === 0) {
            this.session.enemyActions = {};
            return;
        }
        
        // Sort PCs by HP (ascending) to prioritize low-HP targets
        const pcsByHp = [...pcs].sort((a, b) => a.hp - b.hp);
        
        const plans: Record<string, CombatAction> = {};
        let idx = 0;
        
        for (const enemy of enemies) {
            for (let i = 0; i < enemy.abilities.length; i++) {
                const boxId = `${enemy.id}_AB_${i}`;
                const targetPc = pcsByHp[idx % pcsByHp.length];
                if (!targetPc) continue;
                
                plans[boxId] = {
                    sourceId: enemy.id,
                    sourceAbilityIndex: i,
                    targetId: targetPc.id,
                    targetAbilityIndex: 0
                };
                
                idx++;
            }
        }
        
        this.session.enemyActions = plans;
    }
    
    // Get current session state for client
    getState(): {
        sessionId: string;
        units: Record<string, CombatUnit>;
        phase: string;
        turn: number;
        turnOrder: string[];
        enemyActions: Record<string, CombatAction>;
        result: 'victory' | 'defeat' | null;
    } {
        return {
            sessionId: this.session.sessionId,
            units: this.session.units,
            phase: this.session.phase,
            turn: this.session.turn,
            turnOrder: this.session.turnOrder,
            enemyActions: this.session.enemyActions,
            result: this.checkWinLoss()
        };
    }
}

// Session Management Functions with MongoDB persistence

// Create a new combat session and store in MongoDB
export async function createSession(
    username: string,
    chapter: number,
    level: number,
    pcData: Record<string, any>,
    enemyData: Record<string, any>
): Promise<CombatSession> {
    // Check for existing active session for this user
    const existingSession = await getSessionByUsername(username);
    if (existingSession && existingSession.phase !== 'VICTORY' && existingSession.phase !== 'DEFEAT') {
        // Return existing session if still active
        console.log(`Returning existing session for user ${username}: ${existingSession.sessionId}`);
        return existingSession;
    }
    
    const sessionId = generateSessionId();
    
    const units: Record<string, CombatUnit> = {};
    
    // Build PC units
    let pcIndex = 0;
    for (const [name, data] of Object.entries(pcData)) {
        const id = `PC${pcIndex}`;
        units[id] = {
            id,
            name,
            type: 'PC',
            maxHp: data.maxHp,
            hp: data.maxHp,
            role: data.role,
            level: data.level || 1,
            ability: data.ability,
            abilities: data.abilities || [data.ability],
            passives: data.passives || [],
            statusEffects: {}
        };
        pcIndex++;
    }
    
    // Build enemy units
    for (const [key, data] of Object.entries(enemyData)) {
        units[key] = {
            id: key,
            name: (data as any).name || key,
            type: 'EN',
            maxHp: (data as any).maxHp,
            hp: (data as any).maxHp,
            level: (data as any).level || 1,
            ability: (data as any).ability,
            abilities: (data as any).abilities || [(data as any).ability],
            passives: (data as any).passives || [],
            statusEffects: {}
        };
    }
    
    const session: CombatSession = {
        sessionId,
        username,
        chapter,
        level,
        units,
        phase: 'PLANNING',
        turn: 1,
        turnOrder: [],
        enemyActions: {},
        pendingActions: {},
        events: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        isConnected: true,
        lastDisconnect: null
    };
    
    // Initialize turn order and enemy plans
    const engine = new CombatEngine(session);
    engine.rollSpeeds();
    engine.computeEnemyPlans();
    
    // Store in cache
    sessionCache.set(sessionId, session);
    
    // Store in MongoDB
    if (combatDb) {
        try {
            await combatDb.collection<CombatSession>('combat_sessions').insertOne(session);
            console.log(`Combat session saved to MongoDB: ${sessionId}`);
        } catch (e) {
            console.error('Failed to save combat session to MongoDB:', e);
        }
    }
    
    return session;
}

// Get session from cache or MongoDB
export async function getSession(sessionId: string): Promise<CombatSession | null> {
    // Check cache first
    const cached = sessionCache.get(sessionId);
    if (cached) {
        return cached;
    }
    
    // Load from MongoDB
    if (combatDb) {
        try {
            const session = await combatDb.collection<CombatSession>('combat_sessions').findOne({ sessionId });
            if (session) {
                // Add to cache
                sessionCache.set(sessionId, session);
                return session;
            }
        } catch (e) {
            console.error('Failed to load combat session from MongoDB:', e);
        }
    }
    
    return null;
}

// Get active session for a user
export async function getSessionByUsername(username: string): Promise<CombatSession | null> {
    // Check cache first
    for (const session of sessionCache.values()) {
        if (session.username === username && session.phase !== 'VICTORY' && session.phase !== 'DEFEAT') {
            return session;
        }
    }
    
    // Load from MongoDB
    if (combatDb) {
        try {
            const session = await combatDb.collection<CombatSession>('combat_sessions').findOne({
                username,
                phase: { $nin: ['VICTORY', 'DEFEAT'] }
            }, { sort: { createdAt: -1 } });
            
            if (session) {
                // Add to cache
                sessionCache.set(session.sessionId, session);
                return session;
            }
        } catch (e) {
            console.error('Failed to load user combat session from MongoDB:', e);
        }
    }
    
    return null;
}

// Update session in cache and MongoDB
export async function updateSession(session: CombatSession): Promise<void> {
    session.updatedAt = new Date();
    
    // Update cache
    sessionCache.set(session.sessionId, session);
    
    // Update MongoDB
    if (combatDb) {
        try {
            await combatDb.collection<CombatSession>('combat_sessions').updateOne(
                { sessionId: session.sessionId },
                { $set: session },
                { upsert: true }
            );
        } catch (e) {
            console.error('Failed to update combat session in MongoDB:', e);
        }
    }
}

// Mark session as disconnected (player left but can rejoin)
export async function markSessionDisconnected(sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    if (session) {
        session.isConnected = false;
        session.lastDisconnect = new Date();
        await updateSession(session);
    }
}

// Mark session as connected (player rejoined)
export async function markSessionConnected(sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    if (session) {
        session.isConnected = true;
        session.lastDisconnect = null;
        await updateSession(session);
    }
}

// Delete session from cache and MongoDB
export async function deleteSession(sessionId: string): Promise<boolean> {
    // Remove from cache
    const cached = sessionCache.delete(sessionId);
    
    // Remove from MongoDB
    if (combatDb) {
        try {
            const result = await combatDb.collection('combat_sessions').deleteOne({ sessionId });
            return cached || result.deletedCount > 0;
        } catch (e) {
            console.error('Failed to delete combat session from MongoDB:', e);
        }
    }
    
    return cached;
}

// Execute combat turn with MongoDB persistence
export async function executeCombatTurn(
    sessionId: string,
    playerActions: Record<string, CombatAction>
): Promise<{ events: CombatEvent[]; state: ReturnType<CombatEngine['getState']> } | null> {
    const session = await getSession(sessionId);
    if (!session) return null;
    
    session.pendingActions = playerActions;
    session.updatedAt = new Date();
    
    const engine = new CombatEngine(session);
    const events = engine.executeTurn(playerActions);
    
    // Store events in session history
    session.events.push(...events);
    
    // Persist to MongoDB
    await updateSession(session);
    
    return {
        events,
        state: engine.getState()
    };
}

// Update enemy plans and persist
export async function updateEnemyPlans(
    sessionId: string,
    pendingActions: Record<string, { targetId: string; targetAbilityIndex?: number }>
): Promise<Record<string, CombatAction> | null> {
    const session = await getSession(sessionId);
    if (!session) return null;
    
    const newEnemyActions: Record<string, CombatAction> = { ...session.enemyActions };
    
    // For each pending player action, if targeting an enemy ability box,
    // update that enemy's plan to counter the attacker
    for (const [pcId, action] of Object.entries(pendingActions || {})) {
        if (action && typeof action === 'object') {
            const enemyId = action.targetId;
            const abilityIndex = action.targetAbilityIndex || 0;
            const boxId = `${enemyId}_AB_${abilityIndex}`;
            
            // Enemy counters the player who targeted them
            if (session.units[enemyId]?.type === 'EN') {
                newEnemyActions[boxId] = {
                    sourceId: enemyId,
                    sourceAbilityIndex: abilityIndex,
                    targetId: pcId,
                    targetAbilityIndex: 0
                };
            }
        }
    }
    
    session.enemyActions = newEnemyActions;
    await updateSession(session);
    
    return newEnemyActions;
}

// Cleanup old disconnected sessions (call periodically)
export async function cleanupOldSessions(): Promise<number> {
    if (!combatDb) return 0;
    
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
    
    try {
        const result = await combatDb.collection('combat_sessions').deleteMany({
            $or: [
                { lastDisconnect: { $lt: cutoffTime } },
                { createdAt: { $lt: cutoffTime } }
            ]
        });
        
        // Also clean up cache
        for (const [sessionId, session] of sessionCache.entries()) {
            if (session.createdAt < cutoffTime || (session.lastDisconnect && session.lastDisconnect < cutoffTime)) {
                sessionCache.delete(sessionId);
            }
        }
        
        return result.deletedCount;
    } catch (e) {
        console.error('Failed to cleanup old sessions:', e);
        return 0;
    }
}
