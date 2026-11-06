// T18c (ADR-0013 decision 3): generator for the retrieval-benchmark dataset.
// Everything here is FICTIONAL - invented weather-station firmware team
// (stormchaser), three seats (lead, builder, checker) plus an owner, 5 days
// (2026-10-12 .. 2026-10-16), two missions (sensor-rig, power-core).
// Nothing is drawn from any real rig, transcript or project.
//
// Run:  bun tests/bench/gen-dataset.ts
// Writes tests/bench/dataset/{conclusions,messages,questions}.json and
// validates every invariant (counts, unique content, expected/must_not/known
// id membership, pair consistency) BEFORE writing - the same invariants the
// unit test re-checks without a server.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = join(import.meta.dir, "dataset");

// ---------------------------------------------------------------- fixtures

const DAY = (d: number, hm: string): string =>
  `2026-10-${String(12 + d).padStart(2, "0")}T${hm}:00Z`;

type Concl = {
  id: string;
  observer: string;
  observed: string;
  session: string;
  mission: string;
  created_at: string;
  content: string;
};
type Msg = {
  id: string;
  sender: string;
  session: string;
  mission: string;
  created_at: string;
  text: string;
};
type Q = {
  id: string;
  job: "continuity" | "decision" | "lesson" | "peer" | "provenance" | "history";
  text: string;
  as_of: string;
  pairs: [string, string][];
  expect: string[];
  must_not: string[];
  known: string[];
};

const concl: Concl[] = [];
let n = 0;
const add = (
  observer: string,
  observed: string,
  mission: string,
  created_at: string,
  content: string,
): string => {
  const id = `b-${String(++n).padStart(3, "0")}`;
  concl.push({ id, observer, observed, session: `${observer}--${mission}--1`, mission, created_at, content });
  return id;
};

// ---- decisions (some superseded later, same subject) --------------------
const dLoRa868 = add("lead", "lead", "sensor-rig", DAY(0, "09:12"), "Decision: the uplink radio runs LoRa at 868 MHz because the first customer sites are in the EU.");
const dSensorI2C = add("lead", "lead", "sensor-rig", DAY(0, "09:31"), "Decision: sensor board talks to the MCU over I2C bus 1, not SPI, to keep SPI free for the flash chip.");
const dLogFlash = add("lead", "lead", "sensor-rig", DAY(0, "11:05"), "Decision: readings log to SPI flash in a ring buffer, 7 days at 1-minute sampling.");
const dBootloader = add("lead", "lead", "power-core", DAY(1, "10:02"), "Decision: keep the stock MCU bootloader; a custom bootloader is out of scope for v1.");
const dOTAold = add("lead", "lead", "power-core", DAY(1, "10:06"), "Decision: no OTA in v1; field flashing by hand stays simpler and the update risk is not worth it.");
const dWatchdog = add("lead", "lead", "power-core", DAY(1, "10:40"), "Decision: enable the hardware watchdog at 8 s; a stuck loop must reset into the logger, not hang.");
const dBattery = add("lead", "lead", "power-core", DAY(1, "14:22"), "Decision: LiFePO4 cells, not LiPo - the winter temperature range kills LiPo capacity.");
const dDeepSleep = add("lead", "lead", "power-core", DAY(2, "09:18"), "Decision: the node deep-sleeps between samples; wake budget 40 uA average.");
const dLoRa915 = add("lead", "lead", "sensor-rig", DAY(4, "10:15"), "Decision: the uplink radio runs LoRa at 915 MHz after all - the second customer batch ships to the US, and 868 MHz is retired for this product.");
const dOTA = add("lead", "lead", "power-core", DAY(4, "11:40"), "Decision: OTA updates ship in v1 after all, gated behind the watchdog rule; earlier no-OTA note is retired.");
const dSampleRate = add("lead", "lead", "sensor-rig", DAY(3, "16:02"), "Decision: field sampling stays at 1 minute; 5-minute sampling was too coarse for frost events.");
const dEnclosure = add("lead", "lead", "sensor-rig", DAY(2, "13:35"), "Decision: enclosure is UV-stable ASA printed, not ABS - ABS went chalky in the summer test.");
const dAntenna = add("lead", "lead", "sensor-rig", DAY(3, "09:26"), "Decision: external SMA antenna, not the onboard ceramic; the mast mount shielded the ceramic one.");
const dTimeSync = add("lead", "lead", "sensor-rig", DAY(1, "15:48"), "Decision: timestamps come from the RTC disciplined by LoRa network time, never from a phone app.");
const dCalib = add("lead", "lead", "sensor-rig", DAY(2, "15:12"), "Decision: two-point calibration per unit at factory, offset stored in flash, not baked into firmware.");
const dFirmwareLayout = add("lead", "lead", "power-core", DAY(3, "10:44"), "Decision: one firmware binary for both board revisions, revision detected at boot from the ID resistor.");
const dPowerFailPolicy = add("lead", "lead", "power-core", DAY(4, "15:30"), "Decision: on battery-critical the node keeps logging and stops transmitting; data beats reach for this product.");
const dRetryBudget = add("lead", "lead", "power-core", DAY(2, "11:58"), "Decision: uplink retries burn at most 2 percent of the daily power budget, then wait for the next window.");
const dBomCeiling = add("lead", "lead", "sensor-rig", DAY(0, "16:40"), "Decision: BOM ceiling 61 credits per node; anything above goes to the lead first.");
const dCert = add("lead", "lead", "power-core", DAY(0, "17:20"), "Decision: certification effort starts only after the field-pilot data review, not before.");
const dGitflow = add("lead", "lead", "sensor-rig", DAY(1, "08:55"), "Decision: main branch stays always-flashable; work lands on topic branches and merges after the checker signs off.");
const dTestRig = add("lead", "lead", "power-core", DAY(2, "16:26"), "Decision: the bench keeps one storm-chaser simulator running nightly so cold-path timing is never untested for a week.");
const dSerialLog = add("lead", "lead", "sensor-rig", DAY(4, "16:12"), "Decision: serial log level drops to warn for field units; the verbose build stays for the bench only.");

// ---- owner approvals ------------------------------------------------------
const aBudget = add("owner", "owner", "sensor-rig", DAY(1, "12:10"), "Owner approved the 61-credit BOM ceiling and the antenna upgrade in the same breath.");
const aPilot = add("owner", "owner", "sensor-rig", DAY(3, "14:05"), "Owner approved the 12-node field pilot on the mill roof, two weekends, weather permit filed.");
const aLiFeePO4 = add("owner", "owner", "power-core", DAY(2, "09:55"), "Owner approved the LiFePO4 cell change including the charger swap cost.");
const aNoFieldEdit = add("owner", "owner", "sensor-rig", DAY(2, "17:40"), "Owner approved the rule that no firmware ever edits calibration bytes in the field; factory tool only.");
const aOtaOwner = add("owner", "owner", "power-core", DAY(4, "13:12"), "Owner approved shipping OTA in v1 with the watchdog gate, overriding the earlier no-OTA stance.");
const aSpareBoards = add("owner", "owner", "sensor-rig", DAY(0, "13:26"), "Owner approved buying three spare board sets for destructive bench testing.");
const aWinterTest = add("owner", "owner", "power-core", DAY(4, "17:05"), "Owner approved the freezer winter test week after the first frost data came in.");
const aOpenSource = add("owner", "owner", "sensor-rig", DAY(3, "10:30"), "Owner approved open-sourcing the enclosure CAD after the pilot, license MIT.");

// ---- lessons (why-shaped) --------------------------------------------------
const lSpareBoard = add("checker", "builder", "sensor-rig", DAY(1, "11:26"), "Lesson: new firmware builds must be flashed on a spare board first, because a bad power setting cooked two main boards last month.");
const lI2CPullups = add("checker", "builder", "sensor-rig", DAY(0, "15:02"), "Lesson: the sensor board ships with 4.7k pull-ups fitted; a bare I2C bus looks dead at 100 kHz and burns a day of guessing.");
const lColdSleep = add("checker", "lead", "power-core", DAY(3, "11:31"), "Lesson: deep-sleep current measured fine warm but doubled under 0 C; the sleep pin leak only shows up cold.");
const lLoRaDuty = add("builder", "builder", "power-core", DAY(2, "12:44"), "Lesson: the 1 percent duty limit applies per channel; spreading retries across three channels tripled the retry budget honestly.");
const lBatteryGauge = add("checker", "builder", "power-core", DAY(3, "13:20"), "Lesson: the fuel-gauge chip lies flat at the LiFePO4 plateau; trust coulomb counting, not the voltage curve.");
const lAntennaSweep = add("builder", "builder", "sensor-rig", DAY(3, "15:07"), "Lesson: sweep the antenna before ordering the enclosure, not after - the first printed box detuned it 3 dB.");
const lFlashWear = add("checker", "builder", "sensor-rig", DAY(4, "09:40"), "Lesson: the flash datasheet wear figure assumed 25 C; the sunny enclosure hits 60 C and halved the write endurance in the bake test.");
const lTimeJump = add("builder", "builder", "sensor-rig", DAY(4, "12:55"), "Lesson: a network-time resync mid-window rewrote earlier readings timestamps; discipline the RTC, never snap it.");
const lWatchdogBoot = add("checker", "lead", "power-core", DAY(2, "10:16"), "Lesson: the watchdog fired during factory test because the bootloader did not pet it; every reset path must service the dog.");
const lSimWeather = add("builder", "builder", "sensor-rig", DAY(1, "16:52"), "Lesson: the storm-chaser simulator needs humidity alongside wind; without it the sensor fusion bug hid for nine days.");
const lSerialBoot = add("builder", "builder", "power-core", DAY(1, "13:08"), "Lesson: the debug UART holds 2 mA at idle when unpowered from USB; float the pins or the wake budget is fiction.");
const lSolderReflow = add("checker", "builder", "sensor-rig", DAY(2, "14:58"), "Lesson: second reflow pass lifted the sensor pad; cover it with tape before reflashing nearby parts.");
const lPacketLoss = add("builder", "lead", "power-core", DAY(4, "14:18"), "Lesson: uplink packet loss clustered at dawn; condensation on the mast antenna, not interference.");
const lDocDrift = add("lead", "lead", "sensor-rig", DAY(4, "10:52"), "Lesson: the wiring doc still said 868 MHz a day after the 915 decision; every radio decision needs a doc edit in the same commit.");

// ---- peer facts ------------------------------------------------------------
const pBuilder = add("lead", "builder", "sensor-rig", DAY(0, "10:20"), "Builder works fast on firmware but skips bench notes until pushed.");
const pCheckerPower = add("lead", "checker", "power-core", DAY(0, "10:24"), "Checker is thorough on power-management code and catches edge cases there.");
const pCheckerDocs = add("builder", "checker", "sensor-rig", DAY(1, "09:44"), "Checker leaves terse review notes but always flags solder-heat risks.");
const pLeadRadio = add("builder", "lead", "sensor-rig", DAY(2, "10:50"), "Lead has the deepest LoRa experience on the team and owns every radio call.");
const pOwnerDates = add("lead", "owner", "sensor-rig", DAY(1, "12:15"), "Owner answers scope questions the same day but wants cost impacts in the first line.");
const pBuilderCold = add("checker", "builder", "power-core", DAY(3, "12:02"), "Builder has the cold-chamber procedure fully memorized and needs no checklist.");
const pCheckerI2C = add("lead", "checker", "sensor-rig", DAY(2, "11:12"), "Checker owns the I2C bus test rig and its fault-injection configs.");
const pLeadBudget = add("builder", "lead", "power-core", DAY(3, "09:48"), "Lead keeps the power budget sheet and updates it after every wake change.");
const pOwnerPilots = add("lead", "owner", "sensor-rig", DAY(3, "14:20"), "Owner handles the field-site permits personally; pilot dates go through them.");
const pBuilderFlash = add("checker", "builder", "sensor-rig", DAY(4, "09:12"), "Builder is the only seat allowed to run the factory calibration tool.");
const pCheckerFreezer = add("builder", "checker", "power-core", DAY(4, "11:26"), "Checker runs the freezer test schedule and tracks every run in a logbook.");
const pLeadRadioOld = add("builder", "lead", "sensor-rig", DAY(0, "08:58"), "Lead comes from a LoRaWAN gateway background; EU band habits run deep.");
const pBuilderPatience = add("checker", "builder", "sensor-rig", DAY(2, "15:44"), "Builder reworks solder joints patiently but rushes harness assembly.");
const pOwnerCost = add("checker", "owner", "sensor-rig", DAY(2, "16:50"), "Owner approves hardware spend fast when the BOM delta is under 5 credits.");
const pCheckerSim = add("lead", "checker", "sensor-rig", DAY(4, "13:40"), "Checker extended the storm-chaser simulator with a frost profile this week.");

// ---- current-state chains (fresh entries supersede stale ones) -----------
const cDriver1 = add("builder", "builder", "sensor-rig", DAY(0, "09:40"), "Builder is waiting on the sensor driver bring-up; the vendor header is missing.");
const cDriver2 = add("builder", "builder", "sensor-rig", DAY(2, "17:30"), "Sensor driver merged yesterday; builder moved on to the flash ring buffer.");
const cDriver3 = add("builder", "builder", "sensor-rig", DAY(4, "15:44"), "Builder is on the calibration tool now; ring buffer passed soak.");
const cBuild1 = add("builder", "builder", "power-core", DAY(1, "10:55"), "Deep-sleep branch builds clean but has no field soak yet.");
const cBuild2 = add("builder", "builder", "power-core", DAY(3, "17:15"), "Deep-sleep branch soaked 72 h warm; the cold soak is next week in the freezer.");
const cPilot1 = add("lead", "lead", "sensor-rig", DAY(2, "09:30"), "Field pilot not scheduled; still waiting on the roof permit.");
const cPilot2 = add("lead", "lead", "sensor-rig", DAY(3, "14:25"), "Field pilot set: 12 nodes on the mill roof, first weekend of the coming month.");
const cPilot3 = add("lead", "lead", "sensor-rig", DAY(4, "17:25"), "Field pilot prepped: nodes flashed, antennas mounted, checklist in the pilot binder.");
const cRadio1 = add("builder", "builder", "sensor-rig", DAY(0, "14:10"), "Radio stack runs 868 MHz and passed the EU duty-cycle test bench.");
const cRadio2 = add("builder", "builder", "sensor-rig", DAY(4, "11:02"), "Radio stack rebuilt for 915 MHz; duty-cycle retest is running on the bench.");
const cPower1 = add("checker", "checker", "power-core", DAY(1, "15:20"), "Wake budget measured at 55 uA average, over the 40 uA target.");
const cPower2 = add("checker", "checker", "power-core", DAY(3, "16:48"), "Wake budget now 38 uA warm after the UART pin fix; cold number pending.");
const cFreeze1 = add("checker", "checker", "power-core", DAY(3, "11:40"), "Freezer test pending - booked the chamber for next week.");
const cFreeze2 = add("checker", "checker", "power-core", DAY(4, "17:12"), "Freezer test starts Monday, checker holds the chamber key and the logbook.");
const cCalib1 = add("builder", "builder", "sensor-rig", DAY(2, "15:30"), "Factory calibration tool still manual, two points typed by hand.");
const cCalib2 = add("builder", "builder", "sensor-rig", DAY(4, "10:05"), "Calibration tool now scripted from the chamber profile; ten units done error-free.");
const cDocs1 = add("lead", "lead", "sensor-rig", DAY(3, "17:50"), "The hardware doc bundle is half stale, radio section says 868 MHz.");
const cDocs2 = add("lead", "lead", "sensor-rig", DAY(4, "11:00"), "Doc bundle refreshed after the band decision; radio, antenna and BOM pages current again.");
const cCert1 = add("lead", "lead", "power-core", DAY(2, "08:40"), "Certification paperwork untouched, deliberately parked until pilot data.");
const cSim1 = add("checker", "checker", "sensor-rig", DAY(2, "12:15"), "Storm-chaser simulator runs nightly; nine open scenario profiles.");
const cSim2 = add("checker", "checker", "sensor-rig", DAY(4, "14:02"), "Simulator grew a frost profile and a dawn-fog humidity ramp; twelve profiles nightly.");
const cBattery1 = add("builder", "builder", "power-core", DAY(1, "14:50"), "LiFePO4 pack bench: charger still the old LiPo profile, swap blocked on parts.");
const cBattery2 = add("builder", "builder", "power-core", DAY(3, "10:10"), "LiFePO4 charger profile flashed, pack holds plateau through the overnight cycle.");
const cRetest1 = add("builder", "builder", "sensor-rig", DAY(4, "11:48"), "915 duty-cycle retest at 63 percent through the morning window; no violations yet.");
const cRework1 = add("builder", "builder", "sensor-rig", DAY(1, "11:40"), "Two main boards dead from a bad power setting; spare board rule now in force.");

// ---- provenance-shaped (who said / which session, over time) -------------
const vAntenna = add("builder", "lead", "sensor-rig", DAY(3, "09:30"), "Lead chose the external SMA antenna after the mast shielding measured -3 dB on ceramic.");
const vWinter = add("checker", "owner", "power-core", DAY(4, "17:08"), "Owner gave the winter-test green light right after the dawn packet-loss data.");
const vFleet = add("checker", "lead", "power-core", DAY(4, "15:35"), "The keep-logging-stop-transmitting policy came from lead after the frost outage.");
const vCells = add("builder", "lead", "power-core", DAY(1, "14:30"), "Lead picked LiFePO4 after the winter capacity table, not from taste.");
const vSleepRule = add("builder", "checker", "power-core", DAY(2, "10:22"), "The every-reset-path watchdog rule came out of the checker factory-test finding.");

// ---- acknowledgements / trivia (must lose on relevance) -------------------
const triviaSeed: [string, string, string, string][] = [
  ["builder", "builder", "sensor-rig", "Builder used the make tool for the nightly build."],
  ["builder", "builder", "sensor-rig", "Builder acknowledged the checklist update."],
  ["checker", "checker", "sensor-rig", "Checker acknowledged the review request."],
  ["builder", "builder", "power-core", "Builder flashed the bench board again today."],
  ["checker", "checker", "power-core", "Checker ran the bench board again today."],
  ["builder", "builder", "sensor-rig", "Builder formatted the flash card once more."],
  ["checker", "checker", "sensor-rig", "Checker restarted the sensor simulator again."],
  ["builder", "builder", "power-core", "Builder topped up the bench coffee supply."],
  ["checker", "checker", "power-core", "Checker labeled the spare board bin."],
  ["builder", "builder", "sensor-rig", "Builder closed the stale ticket about the fan noise."],
  ["checker", "checker", "sensor-rig", "Checker closed the stale ticket about the label smudge."],
  ["builder", "builder", "power-core", "Builder rebased the no-op branch and pushed nothing."],
  ["checker", "checker", "power-core", "Checker refiled the chamber booking email."],
  ["builder", "builder", "sensor-rig", "Builder swapped in a fresh USB cable on the bench."],
  ["checker", "checker", "sensor-rig", "Checker printed the checklist one more time."],
];
for (let i = 0; i < 51; i++) {
  const t = triviaSeed[i % triviaSeed.length];
  const day = i % 5;
  add(
    t[0],
    t[1],
    t[2],
    DAY(day, `${String(7 + (i % 10)).padStart(2, "0")}:${String(10 + (i % 50)).padStart(2, "0")}`),
    i < triviaSeed.length ? t[3] : `${t[3]} (repeated bench check ${i})`,
  );
}
// fill remaining to 150 with distinct filler facts
const topics = ["wind vane", "anemometer cup", "rain gauge tipping", "solar panel tilt", "mast bracket", "gland plate", "desiccant pack", "door seal", "cable gland", "snorkel vent"];
let ti = 0;
const pad = (v: number): string => String(v).padStart(2, "0");
while (concl.length < 150) {
  const t = topics[ti % topics.length];
  const round = Math.floor(ti / topics.length) + 1;
  const who = ti % 2 ? (["builder", "builder", "sensor-rig"] as const) : (["checker", "checker", "power-core"] as const);
  add(who[0], who[1], who[2], DAY(ti % 5, `${10 + (ti % 6)}:${pad(20 + (ti % 40))}`), `Minor bench note: the ${t} fixture seated cleanly on pass ${round}, nothing to change.`);
  ti++;
}

// ---- messages (context, fictional chat traffic) ---------------------------
const msgScripts: [string, string, string, string, string][] = [
  // [sender, recipient-session-owner, mission, hh:mm, text]
  ["builder", "lead", "sensor-rig", "08:31", "morning: starting sensor driver bring-up today"],
  ["lead", "builder", "sensor-rig", "08:36", "good - vendor header finally in the shared folder"],
  ["checker", "lead", "sensor-rig", "09:02", "review slot freed after ten, send the driver diff there"],
  ["builder", "checker", "sensor-rig", "10:41", "driver diff up, I2C scan looks clean now"],
  ["checker", "builder", "sensor-rig", "11:20", "reviewed. one nit on the reset hold, otherwise good"],
  ["owner", "lead", "sensor-rig", "12:05", "budget: can we afford the external antenna?"],
  ["lead", "owner", "sensor-rig", "12:09", "yes, 2 credits more per node, I recommend it"],
  ["builder", "lead", "power-core", "14:55", "LiPo capacity in the cold test is worse than the datasheet"],
  ["lead", "builder", "power-core", "15:01", "switching to LiFePO4, I will ask owner today"],
  ["checker", "builder", "sensor-rig", "16:12", "the second reflow lifted a pad - tape the sensor next time"],
  ["builder", "checker", "sensor-rig", "16:18", "noted, reworked it. lesson logged"],
  ["lead", "checker", "power-core", "09:15", "watchdog branch merged, please sanity-check the boot path"],
  ["checker", "lead", "power-core", "10:10", "watchdog fired in factory sim - bootloader never pets the dog"],
  ["lead", "checker", "power-core", "10:18", "good catch. rule: every reset path services the dog"],
  ["builder", "checker", "power-core", "13:02", "UART idle current measured 2 mA from USB power"],
  ["checker", "builder", "power-core", "13:26", "float those pins or the whole wake budget is fiction"],
  ["owner", "lead", "sensor-rig", "11:58", "approve the antenna and the spare boards, one line cost impact next time"],
  ["builder", "builder", "sensor-rig", "15:20", "ring buffer soak started, will leave it over the weekend"],
  ["checker", "lead", "power-core", "16:40", "wake budget still 55 uA, over target, need one more pass"],
  ["lead", "checker", "power-core", "16:47", "what is still burning? UART? batteries?"],
  ["builder", "lead", "sensor-rig", "09:20", "antenna sweep: ceramic at -3 dB mounted, external is clean"],
  ["lead", "builder", "sensor-rig", "09:33", "external SMA then, I will write the decision today"],
  ["checker", "checker", "sensor-rig", "12:11", "simulator nightly run green nine nights running"],
  ["builder", "checker", "sensor-rig", "17:35", "sensor driver merged. moving to flash ring buffer"],
  ["owner", "lead", "sensor-rig", "14:00", "can we do the roof pilot? permits are on me"],
  ["lead", "owner", "sensor-rig", "14:12", "yes - 12 nodes, one weekend, I will brief the team"],
  ["builder", "builder", "power-core", "10:22", "LiFePO4 charger profile flashed, overnight cycle pending"],
  ["checker", "builder", "power-core", "11:34", "fuel gauge reads flat all day - that plateau lies, trust coulomb"],
  ["builder", "checker", "power-core", "11:41", "ugh, yes. switching the readout to coulomb counts"],
  ["lead", "builder", "power-core", "16:20", "any movement on the wake budget?"],
  ["checker", "lead", "power-core", "16:52", "38 uA warm after the pin fix. cold number pending freezer"],
  ["builder", "checker", "sensor-rig", "09:50", "915 build boots, radio joins your test gateway"],
  ["checker", "builder", "sensor-rig", "09:58", "seeing the joins, first duty-cycle window running"],
  ["owner", "lead", "power-core", "13:05", "approve OTA in v1 with the watchdog gate. earlier no still stands without it"],
  ["lead", "builder", "power-core", "13:18", "OTA is in v1 now. gate it behind the watchdog rule"],
  ["builder", "builder", "sensor-rig", "10:01", "calibration tool scripted, chamber profile in, ten units clean"],
  ["checker", "lead", "sensor-rig", "11:12", "dawn packet loss again - condensation on the mast, I am sure of it"],
  ["lead", "checker", "sensor-rig", "11:19", "add the snorkel vent to the pilot checklist then"],
  ["builder", "checker", "power-core", "14:30", "battery-critical policy up for review: log on, transmit off"],
  ["checker", "builder", "power-core", "15:12", "reviewed, agrees. data beats reach for this product"],
  ["owner", "checker", "power-core", "17:00", "approve the freezer week - frost data convinced me"],
  ["checker", "owner", "power-core", "17:07", "thank you. Monday start, logbook in order"],
  ["builder", "lead", "sensor-rig", "15:50", "915 duty retest 63 percent by noon, no violations"],
  ["lead", "builder", "sensor-rig", "16:05", "excellent. refresh the docs page in the same PR please"],
  ["checker", "checker", "sensor-rig", "14:10", "simulator: frost profile + dawn fog ramp added, twelve profiles"],
  ["builder", "builder", "sensor-rig", "16:30", "nodes flashed for the pilot. antennas torqued, binder checklist printed"],
  ["lead", "checker", "sensor-rig", "17:22", "pilot prepped. run the pre-flight sim tonight and we are done"],
];
const msgs: Msg[] = [];
let mi = 0;
for (let day = 0; day < 5; day++) {
  const perDay = msgScripts.slice(day * 10, day * 10 + 10);
  for (const [sender, recip, mission, hm, text] of perDay) {
    msgs.push({
      id: `m-${String(++mi).padStart(3, "0")}`,
      sender,
      session: `${recip}--${mission}--1`,
      mission,
      created_at: DAY(day, hm),
      text,
    });
  }
}
// top up to 120 with ack-shaped chatter, deterministic
const chatter = [
  "ack", "on it", "done, pushed", "will review after lunch", "bench free now",
  "noted", "thanks for the catch", "same here", "holding until the gate passes", "logbook updated",
];
for (let i = 0; msgs.length < 120; i++) {
  const day = i % 5;
  const sender = ["builder", "checker", "lead"][i % 3];
  const recip = ["lead", "builder", "checker"][(i + 1) % 3];
  const mission = i % 2 ? "sensor-rig" : "power-core";
  msgs.push({
    id: `m-${String(++mi).padStart(3, "0")}`,
    sender,
    session: `${recip}--${mission}--1`,
    mission,
    created_at: DAY(day, `1${(i + 8) % 10}:${String(30 + (i % 30)).slice(-2)}`),
    text: chatter[i % chatter.length],
  });
}

// ---- questions -------------------------------------------------------------
const questions: Q[] = [];
const q = (
  job: Q["job"],
  text: string,
  as_of: string,
  pairs: [string, string][],
  expect: string[],
  must_not: string[],
  known: string[],
): string => {
  const id = `q-${String(questions.length + 1).padStart(3, "0")}`;
  questions.push({ id, job, text, as_of, pairs, expect, must_not, known });
  return id;
};

// continuity (10): "where things stand" at a time; the CURRENT item expected,
// stale chain members must_not.
q("continuity", "is the sensor driver still blocking builder?", DAY(4, "16:00"), [["builder", "builder"]], [cDriver3], [cDriver1, cDriver2], []);
q("continuity", "status of the deep-sleep soak before the freezer week?", DAY(4, "16:00"), [["builder", "builder"]], [cBuild2], [cBuild1], []);
q("continuity", "has the field pilot date moved again?", DAY(4, "17:30"), [["lead", "lead"]], [cPilot3], [cPilot1], [cPilot2]);
q("continuity", "is the radio stack still 868?", DAY(4, "16:00"), [["builder", "builder"]], [cRadio2], [cRadio1], []);
q("continuity", "where is the wake budget right now?", DAY(4, "16:00"), [["checker", "checker"]], [cPower2], [cPower1], []);
q("continuity", "is the freezer test still just booked?", DAY(4, "17:30"), [["checker", "checker"]], [cFreeze2], [cFreeze1], []);
q("continuity", "is calibration still hand-typed?", DAY(4, "16:00"), [["builder", "builder"]], [cCalib2], [cCalib1], []);
q("continuity", "are the hardware docs still stale on the radio section?", DAY(4, "16:00"), [["lead", "lead"]], [cDocs2], [cDocs1], []);
q("continuity", "nightly sim - how many profiles now?", DAY(4, "16:00"), [["checker", "checker"]], [cSim2], [cSim1], []);
q("continuity", "is the LiFePO4 charger swap still waiting on parts?", DAY(4, "16:00"), [["builder", "builder"]], [cBattery2], [cBattery1], []);

// decision (8): current decisions; superseded must stay out.
q("decision", "which LoRa band are we shipping?", DAY(4, "16:00"), [["lead", "lead"]], [dLoRa915], [dLoRa868], []);
q("decision", "is OTA in v1 or not?", DAY(4, "17:00"), [["lead", "lead"]], [dOTA], [], []);
q("decision", "what is the battery chemistry call?", DAY(4, "16:00"), [["lead", "lead"]], [dBattery], [], []);
q("decision", "sampling interval for the field units?", DAY(4, "16:00"), [["lead", "lead"]], [dSampleRate], [], [dLogFlash]);
q("decision", "what happens when the battery runs critical?", DAY(4, "16:00"), [["lead", "lead"]], [dPowerFailPolicy], [], []);
q("decision", "one binary or two for the board revisions?", DAY(4, "16:00"), [["lead", "lead"]], [dFirmwareLayout], [], []);
q("decision", "antenna: onboard or external?", DAY(4, "16:00"), [["lead", "lead"]], [dAntenna], [], []);
q("decision", "who must sign off before a merge to main?", DAY(4, "16:00"), [["lead", "lead"]], [dGitflow], [], []);

// lesson (6): the why-shaped entry answers a fresh mistake risk.
q("lesson", "about to reflash next to the sensor - any hazard?", DAY(3, "18:00"), [["checker", "builder"]], [lSolderReflow], [], []);
q("lesson", "planning to flash tonight's build straight onto a main board, any reason not to?", DAY(2, "18:00"), [["checker", "builder"]], [lSpareBoard], [], []);
q("lesson", "deep-sleep current looks great warm - done?", DAY(4, "18:00"), [["checker", "lead"]], [lColdSleep], [], []);
q("lesson", "fuel gauge says 80 percent all day, believable?", DAY(3, "18:00"), [["checker", "builder"]], [lBatteryGauge], [], []);
q("lesson", "can I spread retries past the 1 percent duty cap?", DAY(3, "18:00"), [["builder", "builder"]], [lLoRaDuty], [], []);
q("lesson", "resyncing network time mid-window, harmless?", DAY(4, "18:00"), [["builder", "builder"]], [lTimeJump], [], []);

// peer (6): what a seat is like / owns.
q("peer", "who catches edge cases in the power code?", DAY(4, "18:00"), [["lead", "checker"]], [pCheckerPower], [], []);
q("peer", "does builder need a checklist in the cold chamber?", DAY(4, "18:00"), [["checker", "builder"]], [pBuilderCold], [], []);
q("peer", "who owns the I2C fault-injection rig?", DAY(4, "18:00"), [["lead", "checker"]], [pCheckerI2C], [], []);
q("peer", "can builder change calibration bytes solo?", DAY(4, "18:00"), [["checker", "builder"]], [pBuilderFlash], [], []);
q("peer", "how fast does owner answer scope questions?", DAY(4, "18:00"), [["lead", "owner"]], [pOwnerDates], [], []);
q("peer", "who runs the freezer schedule?", DAY(4, "18:00"), [["builder", "checker"]], [pCheckerFreezer], [], []);

// provenance (5): who said it / where the call came from.
q("provenance", "who called the external antenna and why?", DAY(4, "18:00"), [["builder", "lead"]], [vAntenna], [], []);
q("provenance", "did the owner actually green-light the winter week?", DAY(4, "18:00"), [["checker", "owner"]], [vWinter], [], []);
q("provenance", "where did the log-on-transmit-off rule come from?", DAY(4, "18:00"), [["checker", "lead"]], [vFleet], [], []);
q("provenance", "was the LiFePO4 choice data or taste?", DAY(4, "18:00"), [["builder", "lead"]], [vCells], [], []);
q("provenance", "who found the bootloader watchdog gap?", DAY(4, "18:00"), [["builder", "checker"]], [vSleepRule], [], []);

// history (5): the OLD decision is the point; the current one is not the answer.
q("history", "what band did we ship before the 915 switch?", DAY(4, "18:00"), [["lead", "lead"]], [dLoRa868], [dLoRa915], []);
q("history", "what was the OTA stance before the approval flipped it?", DAY(4, "18:00"), [["lead", "lead"]], [dOTAold], [dOTA], []);
q("history", "what was blocking builder before the driver merged?", DAY(4, "18:00"), [["builder", "builder"]], [cDriver1], [cDriver2, cDriver3], []);
q("history", "what did the wake budget measure before the UART fix?", DAY(4, "18:00"), [["checker", "checker"]], [cPower1], [cPower2], []);
q("history", "was the pilot ever unscheduled?", DAY(4, "18:00"), [["lead", "lead"]], [cPilot1], [cPilot3], []);

// approvals are decisions too - fold two into the decision set via decision job?
// Keep approvals answerable through the decision questions' owner pair:
q("decision", "is the field pilot actually approved?", DAY(4, "18:00"), [["owner", "owner"]], [aPilot], [], []);
q("decision", "do I still have to ask before destructive bench testing?", DAY(4, "18:00"), [["owner", "owner"]], [aSpareBoards], [], []);
q("lesson", "can the factory tool write calibration in the field?", DAY(4, "18:00"), [["owner", "owner"]], [aNoFieldEdit], [], []);
q("continuity", "is the winter test week approved yet?", DAY(4, "17:40"), [["owner", "owner"]], [aWinterTest], [], []);
q("decision", "does the OTA approval carry the watchdog gate?", DAY(4, "18:00"), [["owner", "owner"]], [aOtaOwner], [], []);

// novelty: two questions where the seat demonstrably already has items
questions[2].known = [cPilot2]; // pilot date moved: seat was in that thread
questions[0].known = [cDriver1];

// ---------------------------------------------------------------- validate
const fail = (m: string): never => {
  throw new Error(`dataset invalid: ${m}`);
};
const ids = new Set(concl.map((c) => c.id));
if (concl.length !== 150) fail(`conclusions ${concl.length} != 150`);
if (msgs.length !== 120) fail(`messages ${msgs.length} != 120`);
if (questions.length < 40) fail(`questions ${questions.length} < 40`);
const byId = new Map(concl.map((c) => [c.id, c]));
const contents = new Set<string>();
for (const c of concl) {
  if (contents.has(c.content)) fail(`duplicate conclusion content: ${c.id}`);
  contents.add(c.content);
}
const jobs: Record<string, number> = {};
for (const qq of questions) {
  if (qq.expect.length === 0) fail(`${qq.id} has no expected id`);
  for (const e of [...qq.expect, ...qq.must_not, ...qq.known]) {
    if (!ids.has(e)) fail(`${qq.id} references unknown id ${e}`);
  }
  for (const e of qq.expect) {
    // every expected id must be reachable by at least one of the pairs
    if (!qq.pairs.some(([o, ob]) => byId.get(e)!.observer === o && byId.get(e)!.observed === ob)) {
      fail(`${qq.id}: expected ${e} not covered by its pairs`);
    }
    if (byId.get(e)!.created_at > qq.as_of) fail(`${qq.id}: expected ${e} newer than as_of`);
  }
  jobs[qq.job] = (jobs[qq.job] ?? 0) + 1;
}
for (const j of ["continuity", "decision", "lesson", "peer", "provenance", "history"]) {
  if (!jobs[j]) fail(`no questions for job ${j}`);
}
// message texts may repeat (ack chatter); only conclusion content must be
// unique - the runner maps server ids back to dataset ids by exact content.

// ---------------------------------------------------------------- write
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "conclusions.json"), JSON.stringify(concl, null, 1) + "\n");
writeFileSync(join(OUT, "messages.json"), JSON.stringify(msgs, null, 1) + "\n");
writeFileSync(join(OUT, "questions.json"), JSON.stringify(questions, null, 1) + "\n");
console.log(
  `wrote dataset: ${concl.length} conclusions, ${msgs.length} messages, ${questions.length} questions`,
  JSON.stringify(jobs),
);
