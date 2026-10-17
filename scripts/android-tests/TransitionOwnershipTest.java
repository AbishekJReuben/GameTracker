package __PACKAGE__;
final class TransitionOwnershipTest {
  private static int assertions;
  private static void check(boolean value){assertions++;if(!value)throw new AssertionError("transition "+assertions);}
  public static void main(String[] args){
    TransitionOwnership ownership=new TransitionOwnership();long a=ownership.begin();check(a>0);check(ownership.current(a));check(ownership.begin()==0);
    ownership.invalidate(a);check(!ownership.current(a));check(ownership.begin()==0); // timed-out PixelCopy still owns its allocation
    ownership.complete(a);long b=ownership.begin();check(b>a);check(ownership.current(b));ownership.complete(a);check(ownership.begin()==0); // late callback cannot free its successor
    ownership.invalidate();check(!ownership.current(b));check(ownership.begin()==0);ownership.complete(b);
    long c=ownership.begin();check(c>b);ownership.invalidate(c);check(!ownership.current(c)); // stale queued UI work must exit before allocation
    ownership.complete(c);long d=ownership.begin();check(ownership.current(d));ownership.complete(d);check(ownership.begin()>d);
    System.out.println("Native transition ownership: "+assertions+" assertions passed; no Android or display used.");
  }
}
