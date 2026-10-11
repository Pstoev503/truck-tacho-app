from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import Dict, List

app = FastAPI()

# Речник, в който пазим каналите и хората в тях.
# Формат: {"channel_name": [websocket1, websocket2, ...]}
active_channels: Dict[str, List[WebSocket]] = {}

@app.websocket("/ws/radio/{channel_id}")
async def radio_endpoint(websocket: WebSocket, channel_id: str):
    await websocket.accept()
    
    # Ако каналът не съществува, го създаваме
    if channel_id not in active_channels:
        active_channels[channel_id] = []
        
    active_channels[channel_id].append(websocket)
    print(f"Нов слушател в канал '{channel_id}'. Общо вътре: {len(active_channels[channel_id])}")
    
    try:
        while True:
            # Приемаме аудиото
            audio_data = await websocket.receive_bytes()
            
            # Разпръскваме го само на хората в СЪЩИЯ канал
            for client in active_channels[channel_id]:
                if client != websocket: 
                    try:
                        await client.send_bytes(audio_data)
                    except:
                        pass
    except WebSocketDisconnect:
        active_channels[channel_id].remove(websocket)
        # Изчистваме канала, ако остане празен
        if not active_channels[channel_id]:
            del active_channels[channel_id]
