import {Pool} from './pool.mts';
import {problem, reply, serve} from './http.mts';
import {parseInput} from './schema.mts';

export async function startCompute(pool: Pool): Promise<void> {
  try {
    serve(() => ({ok: true, ...pool.stats()}), async (body, response, signal) => {
      const input = parseInput(body);
      if (!input) return problem(response, 400, 'invalid_request');
      const result = await pool.submit(input, signal);
      if ('digest' in result) return reply(response, 200, result);
      const {code} = result;
      if (code === 'cancelled') return;
      const status = code === 'deadline_exceeded' ? 504 : code === 'worker_failure' ? 502 : 503;
      problem(response, status, code);
    }, () => pool.close(750));
  } catch (error) {
    await pool.close();
    throw error;
  }
}

if (import.meta.main) await startCompute(new Pool());
