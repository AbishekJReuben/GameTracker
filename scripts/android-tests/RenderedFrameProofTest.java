package __PACKAGE__;
final class RenderedFrameProofTest {
  private static int assertions;
  private static void check(boolean value) { assertions++;if(!value)throw new AssertionError("check "+assertions); }
  public static void main(String[] args) {
    RenderedFrameProof proof=new RenderedFrameProof();proof.beginFeed(1);proof.beginCodec(3,1);
    check(!proof.rendered(3,1,100,"texture"));proof.output(3,1,100,"texture");
    check(proof.snapshot(1).contains("\"frames\":0")); // released != rendered
    check(!proof.rendered(3,1,100,"surface"));check(proof.rendered(3,1,100,"texture"));
    check(!proof.rendered(3,1,100,"texture"));check(proof.snapshot(4).contains("\"boundsSequence\":4"));
    check(!proof.canReveal(3,1,101,4));check(!proof.reveal(3,1,100,0));check(proof.reveal(3,1,100,4));check(proof.snapshot(4).contains("\"visiblePtsUs\":100"));
    proof.output(3,1,101,"texture");proof.beginFeed(2);proof.beginCodec(4,2);
    check(!proof.rendered(3,1,101,"texture"));check(!proof.rendered(4,2,101,"texture"));
    check(!proof.reveal(3,1,100,4));check(proof.snapshot(4).contains("\"visiblePtsUs\":0"));
    proof.output(4,2,102,"surface");check(!proof.rendered(3,2,102,"surface"));check(!proof.rendered(4,1,102,"surface"));check(proof.rendered(4,2,102,"surface"));
    proof.output(4,2,103,"surface");proof.stopCodec();check(!proof.rendered(4,2,103,"surface"));
    proof.beginCodec(4,2);check(!proof.rendered(4,2,103,"surface"));
    for(long pts=104;pts<204;pts++)proof.output(4,2,pts,"texture");check(proof.pending()==64);check(!proof.rendered(4,2,104,"texture"));check(proof.rendered(4,2,203,"texture"));check(proof.pending()==0);
    System.out.println("Rendered frame proof: "+assertions+" assertions passed; no Android or display used.");
  }
}
