# Firestore standard prices per 100k ops & per GiB-month
FS = {'us-central1':(0.03,0.09,0.15),'nam5':(0.06,0.18,0.18),'me-central2':(0.048,0.144,0.24)}
GiB=1024**3
def egress(gib):
    t=[(10,0),(1024,0.12),(10240,0.11),(1e18,0.08)]
    cost=0;prev=0
    for lim,p in t:
        if gib>prev:
            cost+= (min(gib,lim)-prev)*p
        prev=lim
    return cost
def fs(name,writes_day,reads_day,storage_gib,doc_kb=1.0):
    r,w,s=FS[name]
    bw=max(0,writes_day-20000)*30; br=max(0,reads_day-50000)*30
    cw=bw/1e5*w; cr=br/1e5*r; cs=max(0,storage_gib-1)*s
    eg=egress(reads_day*30*doc_kb*1000/GiB)
    return cw,cr,cs,eg
def show(label,wd,rd,st):
    for n in FS:
        cw,cr,cs,eg=fs(n,wd,rd,st)
        print(f'{label:10s} {n:12s} writes ${cw:9.2f} reads ${cr:10.2f} storage ${cs:9.2f} egress ${eg:9.2f} total ${cw+cr+cs+eg:10.2f}')
# S1
show('S1',500,3200,0.075)
# S2 low/high, yr1 storage 8.4GB, yr9 75GB
show('S2low-y1',150000,150000*5+72000,8.4)
show('S2high-y1',150000,150000*50+72000,8.4)
show('S2low-y9',150000,150000*5+72000,75)
show('S2high-y9',150000,150000*50+72000,75)
# S3A
show('S3A',6_000_000,12_000_000,1024)
# S3B
show('S3Blow-y1',300_000_000,2000*(150000*5+72000),2000*8.4)
show('S3Bhigh-y1',300_000_000,2000*(150000*50+72000),2000*8.4)
show('S3Blow-y9',300_000_000,2000*(150000*5+72000),2000*75)
# Functions (Cloud Run request-based us-central1): invocations, vcpu-s, gib-s
def fn(inv,vcpus,gibs,cpu=0.000024,mem=0.0000025):
    return max(0,inv-2e6)/1e6*0.40 + max(0,vcpus-180000)*cpu + max(0,gibs-360000)*mem
print('S2 fn batched', fn(450000,450000*0.3,450000*0.3*0.5))
print('S2 fn unbatched', fn(4.5e6,4.5e6*0.2,4.5e6*0.2*0.5))
print('S3A fn', fn(18e6,18e6*0.1,18e6*0.1*0.5))
print('S3B fn', fn(900e6,900e6*0.3,900e6*0.3*0.5))
# Identity Platform MAU
def idp(mau):
    tiers=[(50000,0),(100000,0.0055),(1_000_000,0.0046),(10_000_000,0.0032),(1e18,0.0025)]
    c=0;prev=0
    for lim,p in tiers:
        if mau>prev: c+=(min(mau,lim)-prev)*p
        prev=lim
    return c
print('IdP 300k',idp(300000),'1M',idp(1_000_000),'500',idp(500))
# Cloud SQL
print('CloudSQL S1 us', 7.665+10*0.17, 'me2', 12.264+10*0.272)
print('CloudSQL S2 2vcpu8gb us', 2*30.149+8*5.11, '+50GB', 2*30.149+8*5.11+50*0.17, 'HA', 2*60.298+8*10.22+50*0.34)
print('CloudSQL S2 me2', 2*48.253+8*8.176+50*0.272, 'HA', 2*96.506+8*16.352+50*0.544)
print('CloudSQL S3A 8vcpu32 HA us', 8*60.298+32*10.22+1024*0.34, 'me2', 8*96.506+32*16.352+1024*0.544)
print('CloudSQL S3B 20x16vcpu64 HA us y1', 20*(16*60.298+64*10.22)+16800*0.34, 'y9', 20*(16*60.298+64*10.22)+150000*0.34)
# Supabase
def supa(compute,disk_gb,mau,egress_gb,pitr=0):
    return 25-10+compute+max(0,disk_gb-8)*0.125+max(0,mau-100000)*0.00325+max(0,egress_gb-250)*0.09+pitr
print('Supa S2 medium y1',supa(60,8,500,23),'large y9',supa(110,50,500,217))
print('Supa S3A XL',supa(210,1000,300000,342),'2XL',supa(410,1000,300000,342))
print('Supa S3B 20x4XL y1', 20*960+16800*0.125+(1e6-1e5)*0.00325, 'y9', 20*960+150000*0.125+(1e6-1e5)*0.00325)
# Neon
print('Neon S2 1CU 24/7', 730*0.106, '+st y1', 730*0.106+7*0.35, '2CU y9', 2*730*0.106+50*0.35)
print('Neon S3A 4CU', 4*730*0.106+1000*0.35)
print('Neon S3B 2000 proj x1CU launch', 2000*(730*0.106+7*0.35), 'half-day', 2000*(365*0.106+7*0.35))
# PowerSync
def ps(base,synced,conc,hosted,inc_sync=30,inc_conc=1000,inc_host=10):
    return base+max(0,synced-inc_sync)*1+max(0,conc-inc_conc)/1000*30+max(0,hosted-inc_host)*1
print('PS S2 low y1',ps(49,22.5,500,8),'high y9',ps(49,225,500,75))
print('PS S3A team',ps(599,360,15000,1000))
print('PS S3B list',ps(599,45000,500000,16800))
# Turso
print('Turso S2 y9 scaler', 24.92+max(0,50-24)*0.5)
print('Turso S3A scaler', 24.92+(180-100)*0.80+(1000-24)*0.5+(360-24)*0.25, 'pro', 416.58+0+(1000-50)*0.45+(360-100)*0.15)
print('Turso S3B pro y1', 416.58+(9000-250)*0.75+(16800-50)*0.45+(45000-100)*0.15)
# Aiven Dammam monthly
for n,h in [('hobbyist',0.048),('startup-4',0.190),('startup-8',0.396),('business-4',0.438),('business-8',0.889)]:
    print('Aiven me2',n,round(h*730,2))
for n,h in [('hobbyist',0.026),('startup-4',0.103),('startup-8',0.205),('business-4',0.274),('business-8',0.548)]:
    print('Aiven us-c1',n,round(h*730,2))
print('OCI PG fee 1 OCPU',0.098*730,'2 OCPU',2*0.098*730)
print('Couchbase basic node', 0.15*730)
