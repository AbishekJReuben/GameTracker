package __PACKAGE__;

/** Pure Remote-only rotation state machine. Activity owns UI-thread application;
 * tests exercise this exact shipping class without Android framework stubs. */
public final class RemoteRotationPolicy {
    public static final int KEEP = -2;
    public static final int UNSPECIFIED = -1;
    public static final int LOCKED = 14; // ActivityInfo.SCREEN_ORIENTATION_LOCKED
    private boolean active;
    private long holdMs = 1200;
    private int previousPolicy = UNSPECIFIED;
    private int lockedOrientation = UNSPECIFIED;
    private int candidate = UNSPECIFIED;
    private long candidateSince;

    public static long validDelay(long ms) { return ms == 0 ? 0 : ms >= 400 && ms <= 3000 ? ms : 1200; }
    public boolean active() { return active; }
    public long holdMs() { return holdMs; }
    public int previousPolicy() { return previousPolicy; }
    public int lockedOrientation() { return lockedOrientation; }

    public int configure(boolean nextActive, long nextDelay, int currentPolicy, int currentOrientation) {
        nextDelay = validDelay(nextDelay);
        if (active == nextActive && holdMs == nextDelay) return KEEP;
        clearCandidate();
        boolean wasActive = active;
        boolean wasOff = holdMs == 0;
        if (!active && nextActive) previousPolicy = currentPolicy;
        active = nextActive;
        holdMs = nextDelay;
        if (!active) {
            lockedOrientation = UNSPECIFIED;
            return wasActive ? previousPolicy : KEEP;
        }
        if (holdMs == 0 && (!wasActive || !wasOff)) {
            lockedOrientation = currentOrientation;
            return LOCKED;
        }
        // Timed mode starts a fresh candidate; don't rotate to a stale sensor
        // sample or unlock between PiP callbacks.
        return KEEP;
    }
    public int sensor(int orientation, long now, boolean inPip) {
        if (!active || holdMs == 0 || inPip || orientation == UNSPECIFIED) {
            clearCandidate(); return KEEP;
        }
        if (candidate != orientation) { candidate = orientation; candidateSince = now; return KEEP; }
        return now - candidateSince >= holdMs ? orientation : KEEP;
    }
    public void clearCandidate() { candidate = UNSPECIFIED; candidateSince = 0; }
    /** Saved-instance state deliberately excludes the candidate and its clock. */
    public void restore(boolean isActive, long delay, int previous, int locked) {
        active = isActive; holdMs = validDelay(delay); previousPolicy = previous;
        lockedOrientation = locked; clearCandidate();
    }
    public int recreatedOrientation(int savedRequested) {
        if (!active) return previousPolicy;
        return holdMs == 0 && lockedOrientation != UNSPECIFIED ? lockedOrientation : savedRequested;
    }
}
