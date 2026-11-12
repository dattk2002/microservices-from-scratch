export type Feedback = 'success' | 'congestion' | 'neutral';
const inc = (n:number) => Math.min(65535,n+1);
export class Limiter {
  #limit=2; #active=0; #fastStreak=0; #epoch=0; #admitted=0; #rejected=0;
  // Identity is retained only by live tickets; numeric saturation cannot revive them.
  #identity = {};
  state() { return {limit:this.#limit,active:this.#active,fastStreak:this.#fastStreak,epoch:this.#epoch,admitted:this.#admitted,rejected:this.#rejected}; }
  admit(): ((feedback: Feedback, elapsed: number) => void) | undefined {
    if(this.#active>=this.#limit) {this.#rejected=inc(this.#rejected);return;}
    this.#active++;this.#admitted=inc(this.#admitted);
    const identity=this.#identity; let settled=false;
    return (feedback,elapsed) => {
      if(settled)return; settled=true;this.#active--;
      if(identity!==this.#identity)return;
      if(feedback==='congestion'||(feedback==='success'&&elapsed>100)) {
        this.#limit=Math.max(1,Math.floor(this.#limit/2));this.#fastStreak=0;
        this.#epoch=inc(this.#epoch);this.#identity={};
      } else if(feedback==='success') {
        if(++this.#fastStreak===4){this.#limit=Math.min(4,this.#limit+1);this.#fastStreak=0;}
      }
    };
  }
}
