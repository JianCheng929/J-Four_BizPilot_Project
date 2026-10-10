/**
 * The business the user is working in (one login can own or join several).
 * Remembered per browser and sent to the BizPilot server with every call.
 */
const KEY = 'bp.business';

let current: string | null = (() => {
  try { return localStorage.getItem(KEY); } catch { return null; }
})();

export const getCurrentBusinessId = () => current;

export function setCurrentBusinessId(id: string | null) {
  current = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch { /* private window: still works for this tab */ }
}
