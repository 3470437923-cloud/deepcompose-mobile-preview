import mqtt from 'mqtt';
export const BROKER='wss://broker.emqx.io:8084/mqtt';
export function relayClient(role,onState=()=>{}) {
 const client=mqtt.connect(BROKER,{protocolVersion:4,clientId:'dc-'+role+'-'+crypto.randomUUID(),clean:true,keepalive:20,connectTimeout:12000,reconnectPeriod:2500,resubscribe:true,queueQoSZero:false,log:()=>{}});
 client.on('error',()=>onState('offline'));client.on('offline',()=>onState('offline'));client.on('close',()=>onState('offline'));
 return client;
}
export function publish(client,topic,wire){return new Promise((resolve,reject)=>{if(!client.connected)return reject(Error('COMPUTER_OFFLINE'));client.publish(topic,wire,{qos:1,retain:false},error=>error?reject(Error('RELAY_FAILED')):resolve());});}
export function subscribe(client,topic){return new Promise((resolve,reject)=>client.subscribe(topic,{qos:1},(error,granted)=>error||granted?.some(g=>g.qos===128)?reject(Error('RELAY_SUBSCRIBE_FAILED')):resolve()));}
