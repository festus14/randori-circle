// Migration 27: private evaluator-owned writing (#465, ID-102).
// Only new artifacts; no DDL or invalidation trigger on an existing table.
const table=(name,sql)=>Object.freeze({operation:'ensure-table',name,sql});
const index=(name,keyParts)=>Object.freeze({operation:'ensure-index',name,table:'interview_evaluations',
  keyParts:Object.freeze(keyParts),unique:false,where:null,
  sql:`CREATE INDEX IF NOT EXISTS ${name} ON interview_evaluations(${keyParts.join(',')})`});
const trigger=(name,sql)=>Object.freeze({operation:'ensure-trigger',name,table:'interview_evaluations',sql});
const score=name=>`${name} INTEGER CHECK(${name} IS NULL OR (typeof(${name})='integer' AND ${name} BETWEEN 1 AND 4))`;
export const INTERVIEW_EVALUATION_OPERATIONS=Object.freeze([
  table('interview_evaluations',`CREATE TABLE IF NOT EXISTS interview_evaluations (
    week_id INTEGER NOT NULL CHECK(typeof(week_id)='integer' AND week_id>0),
    pair_group_id INTEGER NOT NULL CHECK(typeof(pair_group_id)='integer' AND pair_group_id>0),
    evaluator_user_id INTEGER NOT NULL CHECK(typeof(evaluator_user_id)='integer' AND evaluator_user_id>0),
    candidate_user_id INTEGER NOT NULL CHECK(typeof(candidate_user_id)='integer' AND candidate_user_id>0 AND candidate_user_id<>evaluator_user_id),
    ${score('problem_solving')},${score('communication')},${score('code_quality')},${score('testing')},
    notes TEXT NOT NULL CHECK(typeof(notes)='text' AND length(notes)<=4000 AND length(CAST(notes AS BLOB))<=16000),
    decision TEXT NOT NULL CHECK(decision IN ('undecided','strong_hire','hire','no_hire','strong_no_hire')),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
    created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
    updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
    expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at=created_at+7776000),
    PRIMARY KEY(week_id,pair_group_id,evaluator_user_id),
    FOREIGN KEY(pair_group_id) REFERENCES pairing_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(evaluator_user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(candidate_user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT)`),
  index('idx_interview_evaluations_owner',['evaluator_user_id','created_at DESC','pair_group_id']),
  index('idx_interview_evaluations_expiry',['expires_at','pair_group_id']),
  trigger('trg_interview_evaluations_insert_guard',`CREATE TRIGGER IF NOT EXISTS trg_interview_evaluations_insert_guard BEFORE INSERT ON interview_evaluations FOR EACH ROW WHEN NEW.revision<>1 OR NOT EXISTS (
    SELECT 1 FROM pairing_groups pg
    JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id AND pa.source='auth'
    JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id AND pb.source='auth'
    LEFT JOIN pair_session_controls c ON c.week_id=pg.week_id AND c.pair_group_id=pg.id
    WHERE pg.id=NEW.pair_group_id AND pg.week_id=NEW.week_id AND pg.is_ai_pair=0 AND pg.user_c_id IS NULL
      AND NEW.evaluator_user_id IN (pg.user_a_id,pg.user_b_id) AND NEW.candidate_user_id IN (pg.user_a_id,pg.user_b_id)
      AND COALESCE(c.candidate_user_id,pg.user_a_id)=NEW.candidate_user_id)
    BEGIN SELECT RAISE(ABORT,'invalid evaluation owner'); END`),
  trigger('trg_interview_evaluations_update_guard',`CREATE TRIGGER IF NOT EXISTS trg_interview_evaluations_update_guard BEFORE UPDATE ON interview_evaluations FOR EACH ROW WHEN
    NEW.week_id<>OLD.week_id OR NEW.pair_group_id<>OLD.pair_group_id OR NEW.evaluator_user_id<>OLD.evaluator_user_id
    OR NEW.candidate_user_id<>OLD.candidate_user_id OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
    BEGIN SELECT RAISE(ABORT,'invalid evaluation update'); END`),
]);
