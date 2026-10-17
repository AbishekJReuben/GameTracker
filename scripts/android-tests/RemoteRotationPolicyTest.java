package __PACKAGE__;

public final class RemoteRotationPolicyTest {
    private static int assertions;
    private static void eq(long expected, long actual) {
        assertions++;
        if (expected != actual) throw new AssertionError("expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        // All four physical orientations. Off requests LOCKED immediately and
        // recreation restores its concrete orientation instead of guessing portrait.
        for (int orientation : new int[]{1,0,9,8}) {
            RemoteRotationPolicy p = new RemoteRotationPolicy();
            eq(14,p.configure(true,0,13,orientation));
            eq(-2,p.sensor(orientation == 1 ? 0 : 1,99999,false));
            RemoteRotationPolicy recreated = new RemoteRotationPolicy();
            recreated.restore(p.active(),p.holdMs(),p.previousPolicy(),p.lockedOrientation());
            eq(orientation,recreated.recreatedOrientation(14));
            eq(-2,recreated.configure(true,0,orientation,orientation));
            eq(13,recreated.configure(false,0,orientation,orientation));
            eq(-2,recreated.sensor(0,999999,false));
        }
        RemoteRotationPolicy p = new RemoteRotationPolicy();
        eq(-2,p.configure(true,1200,-1,1));
        eq(-2,p.sensor(0,100,false));
        eq(-2,p.sensor(0,1299,false)); eq(0,p.sensor(0,1300,false));
        // Off cancels a nearly-matured candidate. Timed resume must start over.
        eq(-2,p.sensor(9,1400,false));
        eq(14,p.configure(true,0,0,0));
        eq(-2,p.sensor(9,99999,false));
        eq(-2,p.configure(true,400,14,0));
        eq(-2,p.sensor(9,100000,false));
        eq(-2,p.sensor(9,100399,false)); eq(9,p.sensor(9,100400,false));
        // PiP suppresses sensor work and resets pending timed candidates, but
        // doesn't release/re-acquire the preceding policy or change the lock.
        eq(-2,p.sensor(1,100500,false));
        eq(-2,p.sensor(1,101000,true));
        eq(-2,p.sensor(1,102000,false)); eq(-2,p.sensor(1,102399,false)); eq(1,p.sensor(1,102400,false));
        // Invalid cardinal samples clear the candidate too.
        eq(-2,p.sensor(-1,102500,false)); eq(-2,p.sensor(1,103000,false));
        eq(-1,p.configure(false,400,1,1));
        eq(-2,p.configure(false,1200,-1,1));
        for (long valid : new long[]{0,400,450,1200,3000}) eq(valid,RemoteRotationPolicy.validDelay(valid));
        for (long invalid : new long[]{-1,1,399,3001,Long.MAX_VALUE}) eq(1200,RemoteRotationPolicy.validDelay(invalid));
        System.out.println("RemoteRotationPolicy: " + assertions + " lifecycle assertions passed");
    }
}
