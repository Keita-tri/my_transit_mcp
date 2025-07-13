#!/usr/bin/env node
import { createServer } from 'http';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from 'zod';
import { get_encoding } from 'tiktoken';
import express, { Request, Response } from 'express'; // RequestとResponseをインポート

import { fetchSuggest, fetchRouteSearch } from './fetcher.js';
import { parseRouteSearchResult } from './parser.js';

const encoder = get_encoding('cl100k_base');

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const host = process.env.HOST || '0.0.0.0';

// Expressアプリケーションの初期化
const app = express();
app.use(express.json()); // JSONボディパーサーを使用

// 1. StreamableHTTPServerTransportのインスタンスを作成
// ステートレスサーバーとして実装するため、sessionIdGeneratorはundefinedにします
const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
});

// MCPサーバーのインスタンスを作成
const mcpServer = new McpServer({
    name: "japan-transfer-mcp",
    version: "0.1.0"
});

/**
 * 経路検索結果を自然な文章形式でフォーマットする
 */
function formatRouteSearchResponse(result: any, searchUrl: string, from: string, to: string, datetime: string): string {
    const lines: string[] = [];
    
    // ヘッダー情報
    lines.push(`🚃 **${from}** から **${to}** への経路検索結果`);
    lines.push(`📅 検索日時: ${datetime}`);
    lines.push(`🔗 検索URL: ${searchUrl}`);
    lines.push(`⏰ 検索実行時刻: ${result.searchTime}`);
    lines.push('');
    
    if (!result.routes || result.routes.length === 0) {
        lines.push('❌ 該当する経路が見つかりませんでした。');
        return lines.join('\n');
    }
    
    lines.push(`📋 **${result.routes.length}件の経路が見つかりました**`);
    lines.push('');
    
    // 各経路の詳細
    result.routes.forEach((route: any, index: number) => {
        lines.push(`## 🛤️ 経路${route.routeNumber}: ${route.timeInfo.departure} → ${route.timeInfo.arrival}`);
        
        // 基本情報
        const basicInfo = [];
        if (route.totalTime) {
            const hours = Math.floor(route.totalTime / 60);
            const minutes = route.totalTime % 60;
            basicInfo.push(`⏱️ 所要時間: ${hours > 0 ? `${hours}時間` : ''}${minutes}分`);
        }
        if (route.transfers !== undefined) {
            basicInfo.push(`🔄 乗換: ${route.transfers}回`);
        }
        if (route.fareInfo?.total) {
            basicInfo.push(`� 運賃: ${route.fareInfo.total.toLocaleString()}円`);
        }
        if (route.totalDistance) {
            basicInfo.push(`📏 距離: ${route.totalDistance}km`);
        }
        
        if (basicInfo.length > 0) {
            lines.push(basicInfo.join(' | '));
        }
        
        // タグ情報
        if (route.tags && route.tags.length > 0) {
            const tagText = route.tags.map((tag: any) => {
                switch (tag.type) {
                    case 'fast': return '⚡早い';
                    case 'comfortable': return '😌楽';
                    case 'cheap': return '💰安い';
                    case 'car': return '🚗車';
                    default: return tag.label;
                }
            }).join(' ');
            lines.push(`🏷️ ${tagText}`);
        }
        
        // CO2情報
        if (route.co2Info) {
            lines.push(`🌱 CO2排出量: ${route.co2Info.amount}${route.co2Info.reductionRate ? ` (${route.co2Info.comparison}${route.co2Info.reductionRate}削減)` : ''}`);
        }
        
        lines.push('');
        
        // 経路詳細
        if (route.segments && route.segments.length > 0) {
            lines.push('### 📍 経路詳細');
            
            route.segments.forEach((segment: any, segIndex: number) => {
                if (segment.type === 'station' && segment.station) {
                    const station = segment.station;
                    let stationLine = '';
                    
                    // 駅タイプによるアイコン
                    switch (station.type) {
                        case 'start':
                            stationLine = `🚩 **出発**: ${station.name}`;
                            break;
                        case 'end':
                            stationLine = `🏁 **到着**: ${station.name}`;
                            break;
                        case 'transfer':
                            stationLine = `🔄 **乗換**: ${station.name}`;
                            break;
                        default:
                            stationLine = `📍 ${station.name}`;
                    }
                    
                    // プラットフォーム情報
                    if (station.platform) {
                        stationLine += ` (${station.platform})`;
                    }
                    
                    // 天気情報
                    if (station.weather) {
                        const weatherIcons: Record<string, string> = {
                            'sunny': '☀️',
                            'cloudy': '☁️',
                            'rainy': '🌧️',
                            'snowy': '❄️'
                        };
                        const weatherIcon = weatherIcons[station.weather.condition] || '🌤️';
                        stationLine += ` ${weatherIcon}`;
                    }
                    
                    lines.push(stationLine);
                    
                } else if (segment.type === 'transport' && segment.transport) {
                    const transport = segment.transport;
                    let transportLine = '';
                    
                    // 交通手段タイプによるアイコン
                    const transportIcons: Record<string, string> = {
                        'train': '🚃',
                        'subway': '🚇',
                        'bus': '🚌',
                        'car': '🚗',
                        'taxi': '🚕',
                        'walk': '🚶'
                    };
                    const transportIcon = transportIcons[transport.type] || '🚃';
                    
                    transportLine = `${transportIcon} ${transport.lineName}`;
                    
                    // 時刻情報
                    if (transport.timeInfo) {
                        const timeText = [];
                        if (transport.timeInfo.departure && transport.timeInfo.arrival) {
                            timeText.push(`${transport.timeInfo.departure}-${transport.timeInfo.arrival}`);
                        }
                        if (transport.timeInfo.duration) {
                            timeText.push(`${transport.timeInfo.duration}分`);
                        }
                        if (timeText.length > 0) {
                            transportLine += ` (${timeText.join(', ')})`;
                        }
                    }
                    
                    // 運賃情報
                    if (transport.fare) {
                        transportLine += ` 💰${transport.fare}円`;
                    }
                    
                    // 距離情報
                    if (transport.distance) {
                        transportLine += ` 📏${transport.distance}`;
                    }
                    
                    lines.push(`  ${transportLine}`);
                }
            });
        }
        
        // 注意事項
        if (route.routeNotices && route.routeNotices.length > 0) {
            lines.push('');
            lines.push('### ⚠️ 注意事項');
            route.routeNotices.forEach((notice: any) => {
                lines.push(`- ${notice.title}${notice.description && notice.description !== notice.title ? `: ${notice.description}` : ''}`);
            });
        }
        
        lines.push('');
        lines.push('---');
        lines.push('');
    });
    
    return lines.join('\n');
}

// search_station_by_name
const searchStationHandler = async (
    { query, maxTokens, onlyName }: { query: string; maxTokens?: number; onlyName?: boolean; }
) => {
    try {
        const response = await fetchSuggest({
            query,
            format: "json",
        })
        const railwayPlaces = response.R?.map((place) => {
            if (onlyName) {
                return place.poiName
            }
            return `${place.poiName}（${place.prefName}${place.cityName ? place.cityName : ''}, citycode: ${place.cityCode ?? '不明'}, 緯度: ${place.location.lat}, 経度: ${place.location.lon}, よみ: ${place.poiYomi}）`;
        })
        const busPlaces = response.B?.map((place) => {
            if (onlyName) {
                return place.poiName
            }
            return `${place.poiName}（${place.prefName}${place.cityName ? place.cityName : ''}, citycode: ${place.cityCode ?? '不明'}, 緯度: ${place.location.lat}, 経度: ${place.location.lon}, よみ: ${place.poiYomi}）`;
        })
        const spots = response.S?.map((place) => {
            if (onlyName) {
                return place.poiName
            }
            return `${place.poiName}（${place.prefName}${place.cityName ? place.cityName : ''}${place.address ? ' ' + place.address : ''}, citycode: ${place.cityCode ?? '不明'}, 緯度: ${place.location.lat}, 経度: ${place.location.lon}, よみ: ${place.poiYomi}）`;
        })
        const maxLen = Math.max(
            railwayPlaces ? railwayPlaces.length : 0,
            busPlaces ? busPlaces.length : 0,
            spots ? spots.length : 0
        );
        const merged = [];
        for (let i = 0; i < maxLen; i++) {
            if (railwayPlaces && railwayPlaces[i] !== undefined) merged.push(railwayPlaces[i]);
            if (busPlaces && busPlaces[i] !== undefined) merged.push(busPlaces[i]);
            if (spots && spots[i] !== undefined) merged.push(spots[i]);
        }
        let result = "";
        let tokenCount = 0;
        let max = typeof maxTokens === "number" ? maxTokens : Infinity;
        for (let i = 0; i < merged.length; i++) {
            const next = (result ? "," : "") + merged[i];
            const tokens = encoder.encode(result + next);
            if (tokens.length > max) break;
            result += (result ? "," : "") + merged[i];
            tokenCount = tokens.length;
        }
        return {
            content: [{
                type: "text",
                text: result
            }] as any
        };
    } catch (error) {
        return {
            content: [{
                type: "text",
                text: `Contact retrieval error: ${error instanceof Error ? error.message : String(error)}`
            }] as any,
            isError: true
        };
    }
};

// 2. mcpServer.tool() を使用してツールを登録
mcpServer.tool("search_station_by_name",
    "Search for stations by name",
    {
        query: z.string().describe("The name of the station to search for (must be in Japanese)"),
        maxTokens: z.number().optional().describe("The maximum number of tokens to return"),
        onlyName: z.boolean().optional().describe("Whether to only return the name of the station. If you do not need detailed information, it is generally recommended to set this to true."),
    },
    searchStationHandler
);


// search_route_by_station_name
const searchRouteHandler = async (
    { from, to, datetimeType, datetime, maxTokens }: { from: string; to: string; datetimeType: "departure"|"arrival"|"first"|"last"; datetime?: string; maxTokens?: number; }
) => {
    try {
        if (!datetime) {
            const now = new Date();
            const jpNow = new Date(now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
            const pad = (n: number) => n.toString().padStart(2, "0");
            datetime = `${jpNow.getFullYear()}-${pad(jpNow.getMonth() + 1)}-${pad(jpNow.getDate())} ${pad(jpNow.getHours())}:${pad(jpNow.getMinutes())}:${pad(jpNow.getSeconds())}`;
        }
        const datePart = datetime.split(" ")[0];
        const timePart = datetime.split(" ")[1];
        const [year, month, day] = datePart.split("-").map(Number);
        const [hour, minute] = timePart.split(":").map(Number);
        const isFromBusStop = from.includes("〔") || from.includes("［");
        const isToBusStop = to.includes("〔") || to.includes("［");
        const response = await fetchRouteSearch({
            eki1: from,
            eki2: to,
            Dyy: year,
            Dmm: month,
            Ddd: day,
            Dhh: hour,
            Dmn1: Math.floor(minute / 10),
            Dmn2: minute % 10,
            Cway: (() => {
                switch (datetimeType) {
                    case "departure": return 0;
                    case "arrival": return 1;
                    case "first": return 2;
                    case "last": return 3;
                    default: return 0;
                }
            })(),
            via_on: -1,
            Cfp: 1,
            Czu: 2,
            C7: 1,
            C2: 0,
            C3: 0,
            C1: 0,
            cartaxy: 1,
            bikeshare: 1,
            sort: "time",
            C4: 5,
            C5: 0,
            C6: 2,
            S: "検索",
            Cmap1: "",
            rf: "nr",
            pg: 0,
            eok1: isFromBusStop ? "B-" : "R-",
            eok2: isToBusStop ? "B-" : "R-",
            Csg: 1
        })
        const parsedResult = parseRouteSearchResult(response.data);
        let resultText = formatRouteSearchResponse(parsedResult, response.url, from, to, datetime);
        if (maxTokens) {
            const tokens = encoder.encode(resultText);
            if (tokens.length > maxTokens) {
                const limitedResult = {
                    ...parsedResult,
                    routes: parsedResult.routes.slice(0, Math.max(1, Math.floor(parsedResult.routes.length * maxTokens / tokens.length)))
                };
                resultText = formatRouteSearchResponse(limitedResult, response.url, from, to, datetime);
            }
        }
        return {
            content: [{
                type: "text",
                text: resultText
            }] as any
        };
    } catch (error) {
        return {
            content: [{
                type: "text",
                text: `Route search error: ${error instanceof Error ? error.message : String(error)}`
            }] as any,
            isError: true
        };
    }
};

mcpServer.tool("search_route_by_station_name",
    "Search for routes by station name",
    {
        from: z.string().describe("The name of the departure station. The value must be a name obtained from search_station_by_name."),
        to: z.string().describe("The name of the arrival station. The value must be a name obtained from search_station_by_name."),
        datetimeType: z.enum(["departure", "arrival","first","last"]).describe("The type of datetime to use for the search"),
        datetime: z.string().optional().describe("The datetime to use for the search. Format: YYYY-MM-DD HH:MM:SS. If not provided, the current time in Japan will be used."),
        maxTokens: z.number().optional().describe("The maximum number of tokens to return"),
    },
    searchRouteHandler
);

// 3. Expressのエンドポイントを設定
// POSTリクエストをtransport.handleRequestで処理
app.post("/mcp", async (req: Request, res: Response) => { // 型を追加
    console.log("Received MCP request:", req.body);
    try {
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                },
                id: null,
            });
        }
    }
});

// GETリクエストはn8nなどのクライアントからのツール一覧取得リクエストに対応するために修正
app.get("/mcp", async (req: Request, res: Response) => { // 型を追加
    console.log("Received GET MCP request for tool discovery.");
    try {
        // サーバーに登録されているツールのリストを取得
        // 'getTools'の代わりに内部プロパティ'_registeredTools'を使用
        const registeredTools = (mcpServer as any)['_registeredTools'] || {};
        const tools = Object.values(registeredTools).map((tool: any) => ({
            name: tool.name,
            description: tool.description,
            // 注意: inputSchemaをJSON Schema形式に変換する必要がある場合がある
            // zod-to-json-schemaのようなライブラリを使うとより正確
            // ここでは簡略化のため、zodのdescriptionをそのまま利用
            arguments_schema: tool.inputSchema.description,
        }));

        // JSON-RPC形式で成功レスポンスを返す
        res.status(200).json({
            jsonrpc: "2.0",
            result: {
                tools: tools,
            },
            // クライアントのバリデーションエラーを回避するため、nullの代わりに固定の文字列IDを設定
            id: "n8n-discovery-request",
        });
    } catch (error) {
        console.error("Error handling GET request:", error);
        res.status(500).json({
            jsonrpc: "2.0",
            error: {
                code: -32603,
                message: "Internal server error during tool discovery.",
            },
            id: null,
        });
    }
});


// DELETEリクエストも互換性のために405を返す
app.delete("/mcp", async (req: Request, res: Response) => { // 型を追加
    console.log("Received DELETE MCP request");
    res.status(405).json({
        jsonrpc: "2.0",
        error: {
            code: -32601, // Method not found
            message: "Method not allowed.",
        },
        id: null,
    });
});


// 4. サーバーのセットアップと起動
const setupAndStartServer = async () => {
    try {
        // MCPサーバーとトランスポートを接続
        await mcpServer.connect(transport);

        // Expressサーバーを起動
        const httpServer = app.listen(port, host, () => {
            console.log(`MCP Server is running on http://${host}:${port}/mcp`);
            // 'getTools'の代わりに内部プロパティ'_registeredTools'のキー一覧を表示
            const registeredTools = (mcpServer as any)['_registeredTools'] || {};
            console.log("Registered tools:", Object.keys(registeredTools));
        });

        // Graceful shutdown
        const shutdown = async () => {
            console.log("Shutting down server...");
            httpServer.close(async () => {
                try {
                    console.log("Closing transport...");
                    await transport.close();
                    await mcpServer.close();
                    console.log("Server shutdown complete.");
                    process.exit(0);
                } catch (error) {
                    console.error("Error during shutdown:", error);
                    process.exit(1);
                }
            });
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

    } catch (err) {
        console.error("Error setting up server:", err);
        process.exit(1);
    }
};

setupAndStartServer();
