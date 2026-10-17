package __PACKAGE__;

import java.util.LinkedHashMap;

/** Frame identity survives the real Surface/TextureView rendered boundary.
 * No feed acceptance, releaseOutputBuffer or performance counter is proof.
 * Pure Java so stale callbacks, source replacement and bounds can be tested. */
final class RenderedFrameProof {
  private static final int LIMIT = 64;
  private final LinkedHashMap<Long, String> outputs = new LinkedHashMap<>();
  private long feed;
  private int generation = -1;
  private long pts;
  private long count;
  private String layer = "";
  private long visiblePts;
  private long visibleBounds;

  synchronized void beginFeed(long session) {
    feed = session;generation = -1;outputs.clear();pts = 0;count = 0;layer = "";visiblePts=0;visibleBounds=0;
  }
  synchronized void beginCodec(int codecGeneration, long session) {
    if (session != feed) return;
    generation = codecGeneration;outputs.clear();pts = 0;count = 0;layer = "";visiblePts=0;visibleBounds=0;
  }
  synchronized void stopCodec() { generation = -1;outputs.clear();pts = 0;count = 0;layer = "";visiblePts=0;visibleBounds=0; }
  synchronized void output(int codecGeneration, long session, long presentationUs, String target) {
    if (codecGeneration != generation || session != feed || presentationUs <= 0) return;
    outputs.put(presentationUs, target);
    while (outputs.size() > LIMIT) outputs.remove(outputs.keySet().iterator().next());
  }
  synchronized boolean rendered(int codecGeneration, long session, long presentationUs, String target) {
    if (codecGeneration != generation || session != feed || presentationUs <= 0 || presentationUs <= pts
        || !target.equals(outputs.get(presentationUs))) return false;
    pts = presentationUs;count++;layer = target;
    outputs.entrySet().removeIf(entry -> entry.getKey() <= presentationUs);
    return true;
  }
  synchronized String snapshot(long boundsSequence) {
    return "{\"version\":2,\"feedSession\":"+feed+",\"codecGeneration\":"+generation+
        ",\"ptsUs\":"+pts+",\"frames\":"+count+",\"boundsSequence\":"+boundsSequence+",\"visiblePtsUs\":"+visiblePts+",\"visibleBoundsSequence\":"+visibleBounds+",\"layer\":\""+layer+"\"}";
  }
  synchronized boolean canReveal(int codecGeneration,long session,long presentationUs,long bounds){return generation==codecGeneration&&feed==session&&presentationUs>0&&presentationUs<=pts&&bounds>0;}
  synchronized boolean reveal(int codecGeneration,long session,long presentationUs,long bounds){if(!canReveal(codecGeneration,session,presentationUs,bounds))return false;visiblePts=Math.max(visiblePts,presentationUs);visibleBounds=bounds;return true;}
  synchronized int pending() { return outputs.size(); }
  synchronized boolean hasFrame(){return pts>0&&generation>=0;}
}
