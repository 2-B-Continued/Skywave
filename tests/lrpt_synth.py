import numpy as np, struct, sys
def rrc(beta, sps, span=16):
    t = np.arange(-span*sps//2, span*sps//2+1)/sps
    h = np.zeros_like(t)
    for i,x in enumerate(t):
        if abs(x)<1e-9: h[i]=1-beta+4*beta/np.pi
        elif abs(abs(x)-1/(4*beta))<1e-9: h[i]=beta/np.sqrt(2)*((1+2/np.pi)*np.sin(np.pi/(4*beta))+(1-2/np.pi)*np.cos(np.pi/(4*beta)))
        else: h[i]=(np.sin(np.pi*x*(1-beta))+4*beta*x*np.cos(np.pi*x*(1+beta)))/(np.pi*x*(1-(4*beta*x)**2))
    return h/np.sqrt(np.sum(h**2))
def make(path, fs=288000, secs=30, snr_db=6, cfo=0.0, amp=40, seed=1):
    rng=np.random.default_rng(seed); sr=72000; sps=fs//sr
    n=int(secs*sr); i=rng.integers(0,2,n)*2-1; q=rng.integers(0,2,n)*2-1
    def up(s): u=np.zeros(n*sps); u[::sps]=s; return u
    h=rrc(0.6,sps)
    I=np.convolve(up(i),h,'same'); Q=np.convolve(np.roll(up(q),sps//2),h,'same')   # OQPSK: Q half a symbol late
    x=(I+1j*Q); p=np.mean(abs(x)**2); x/=np.sqrt(p)
    # noise power for given SNR in signal bandwidth (~sr) ; total fs wide
    npow=1/10**(snr_db/10)*(fs/sr)
    nz=(rng.normal(size=len(x))+1j*rng.normal(size=len(x)))*np.sqrt(npow/2)
    t=np.arange(len(x))/fs; y=(x+nz)*np.exp(2j*np.pi*cfo*t)
    sc=amp/np.std(y)
    raw=np.empty(len(y)*2,dtype=np.uint8)
    raw[0::2]=np.clip(np.round(y.real*sc+127.5),0,255); raw[1::2]=np.clip(np.round(y.imag*sc+127.5),0,255)
    b=raw.tobytes()
    hdr=b"RIFF"+struct.pack("<I",36+len(b))+b"WAVEfmt "+struct.pack("<IHHIIHH",16,1,2,fs,fs*2,2,8)+b"data"+struct.pack("<I",len(b))
    open(path,"wb").write(hdr+b)
if __name__=="__main__":
    make(sys.argv[1],snr_db=float(sys.argv[2]),cfo=float(sys.argv[3]),amp=float(sys.argv[4]) if len(sys.argv)>4 else 40)
