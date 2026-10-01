-- Relabel panel history that was stored under the PVS's old inverter order.
--
-- What happened: the PVS renumbered its inverter indexes while it was failing
-- on 2026-09-19..21 (see docs/operations.md). Every anonymous `pNN` therefore
-- pointed at a different physical panel from slot 2026-09-21T14:15:00Z on,
-- which is the first slot stored after the collector recovered. The lifetime
-- counters were not reset - pairing the last counter before the changeover
-- with the first one after it gives 21 clean one-to-one pairs with +2.1..+3.2
-- kWh between them (two days of production for ~0.25 kW panels), so the
-- permutation below is the physical map, inferred from that continuity:
--
--   p01->p21  p02->p01  p03->p09  p04->p02  p05->p10  p06->p11  p07->p03
--   p08->p12  p09->p13  p10->p04  p11->p14  p12->p05  p13->p15  p14->p16
--   p15->p06  p16->p07  p17->p08  p18->p17  p19->p18  p20->p19  p21->p20
--
-- Run once, from workers/ingest, after the collector has drained (a replayed
-- old batch would write its old label back):
--
--   npx wrangler d1 execute sunpower-monitor --remote --file ../../workers/migrations/2026-09-21-panel-identity-repair.sql
--
-- The permutation is a bijection, so the inverse (swap every -> direction and
-- rerun the same two statements) restores the previous labels exactly. Only
-- rows before the changeover move; the digest column keeps the label each row
-- arrived with, and the dashboard never reads it.
--
-- Two steps, not one: the primary key is (collector_id, panel_id, slot_ts), and
-- every slot holds all 21 panels, so relabelling p01 to p21 collides with the
-- p21 row of the same slot that has not moved yet. Staging through `tmp_pNN`
-- gives every row a free primary key for the swap.

UPDATE panel_sample
SET panel_id = 'tmp_' || panel_id
WHERE collector_id = 'home-pvs' AND slot_ts < 1790000100
  AND panel_id IN ('p01','p02','p03','p04','p05','p06','p07','p08','p09','p10','p11',
                   'p12','p13','p14','p15','p16','p17','p18','p19','p20','p21');

UPDATE panel_sample
SET panel_id = CASE panel_id
  WHEN 'tmp_p01' THEN 'p21'
  WHEN 'tmp_p02' THEN 'p01'
  WHEN 'tmp_p03' THEN 'p09'
  WHEN 'tmp_p04' THEN 'p02'
  WHEN 'tmp_p05' THEN 'p10'
  WHEN 'tmp_p06' THEN 'p11'
  WHEN 'tmp_p07' THEN 'p03'
  WHEN 'tmp_p08' THEN 'p12'
  WHEN 'tmp_p09' THEN 'p13'
  WHEN 'tmp_p10' THEN 'p04'
  WHEN 'tmp_p11' THEN 'p14'
  WHEN 'tmp_p12' THEN 'p05'
  WHEN 'tmp_p13' THEN 'p15'
  WHEN 'tmp_p14' THEN 'p16'
  WHEN 'tmp_p15' THEN 'p06'
  WHEN 'tmp_p16' THEN 'p07'
  WHEN 'tmp_p17' THEN 'p08'
  WHEN 'tmp_p18' THEN 'p17'
  WHEN 'tmp_p19' THEN 'p18'
  WHEN 'tmp_p20' THEN 'p19'
  WHEN 'tmp_p21' THEN 'p20'
  ELSE panel_id
END
WHERE collector_id = 'home-pvs' AND slot_ts < 1790000100
  AND panel_id LIKE 'tmp_p%';
