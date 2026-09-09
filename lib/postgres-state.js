import { isDeepStrictEqual } from "node:util";

export async function updatePostgresState(pool, key, normalize, createDefault, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT value FROM app_state WHERE key = $1 FOR UPDATE", [key]);
    const stored = result.rows[0]?.value;
    const state = normalize(structuredClone(stored ?? createDefault()));
    const callbackResult = await callback(state);
    const normalized = normalize(state);

    if (stored == null) {
      await client.query(
        "INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())",
        [key, JSON.stringify(normalized)],
      );
    } else {
      // Keep the row lock, but only send changed top-level fields to the database.
      const patch = Object.fromEntries(Object.entries(normalized).filter(
        ([field, value]) => !isDeepStrictEqual(stored[field], value),
      ));
      if (Object.keys(patch).length) {
        await client.query(
          "UPDATE app_state SET value = value || $2::jsonb, updated_at = NOW() WHERE key = $1",
          [key, JSON.stringify(patch)],
        );
      }
    }
    await client.query("COMMIT");
    return callbackResult;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function hasClaimableVideoJob(pool, key, lockMs) {
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM app_state AS state,
        jsonb_array_elements(COALESCE(state.value->'videoAnalysisJobs', '[]'::jsonb)) AS jobs(job)
      WHERE state.key = $1 AND (
        job->>'status' IN ('queued_player_detection', 'queued_score_analysis')
        OR (
          job->>'status' IN ('running_player_detection', 'running_score_analysis')
          AND NULLIF(job->>'lockedAt', '')::timestamptz <= $2::timestamptz
        )
      )
    ) AS available
  `, [key, new Date(Date.now() - lockMs).toISOString()]);
  return result.rows[0]?.available === true;
}

export async function readVideoJob(pool, key, sessionId, jobId, knownVersion = "") {
  // Polls return only the caller's account and one job; unchanged images stay in PostgreSQL.
  const result = await pool.query(`
    SELECT auth.account,
      selected.job IS NOT NULL AS found,
      selected.job->>'createdBy' AS owner,
      md5(selected.job::text) AS version,
      CASE WHEN (
        auth.account->>'role' = 'admin'
        OR selected.job->>'createdBy' = auth.account->>'id'
      ) AND md5(selected.job::text) IS DISTINCT FROM $4
        THEN selected.job ELSE NULL END AS job
    FROM app_state AS state
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'id', account->>'id', 'username', account->>'username',
        'displayName', account->>'displayName', 'role', account->>'role',
        'createdAt', account->>'createdAt'
      ) AS account
      FROM jsonb_array_elements(COALESCE(state.value->'sessions', '[]'::jsonb)) AS sessions(session)
      JOIN jsonb_array_elements(COALESCE(state.value->'users', '[]'::jsonb)) AS accounts(account)
        ON account->>'id' = session->>'userId'
      WHERE session->>'id' = $2 AND (session->>'expiresAt')::numeric > $5::numeric
      LIMIT 1
    ) AS auth ON TRUE
    LEFT JOIN LATERAL (
      SELECT job
      FROM jsonb_array_elements(COALESCE(state.value->'videoAnalysisJobs', '[]'::jsonb)) AS jobs(job)
      WHERE job->>'id' = $3
      LIMIT 1
    ) AS selected ON TRUE
    WHERE state.key = $1
  `, [key, sessionId || "", jobId, knownVersion, Date.now()]);
  return result.rows[0] || {};
}
