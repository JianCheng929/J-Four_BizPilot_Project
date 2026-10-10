import { getSupabase } from './db/supabase';

/** True when this user turned on two-step login but has not entered the code in this session. */
export async function needsTwoStepCode(): Promise<boolean> {
  const supa = getSupabase();
  if (!supa) return false;
  const { data, error } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}
