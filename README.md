Use Taos data restful API to commit SQL, API call like "curl -H 'Authorization: Basic <TOKEN>' -d '<SQL>' <ip>:<PORT>/rest/sql/[db_name]"

Input options:
* DB Server: Server config selector
* DB Name: Database to execute SQL
* SQL: SQL statement, SQL combine and process in pre-step

use axios to call http request

Test flow
```
[
    {
        "id": "01ad89bea2c249f6",
        "type": "tab",
        "label": "流程 1",
        "disabled": false,
        "info": "",
        "env": [
            {
                "name": "test",
                "value": "abc",
                "type": "str"
            },
            {
                "name": "path",
                "value": "{\"codes\":\"/usr/local/processing/codes\",\"parameters\":\"/usr/local/processing/parameters\"}",
                "type": "json"
            }
        ]
    },
    {
        "id": "0ab8aa0c7f1b7522",
        "type": "taos-query",
        "z": "01ad89bea2c249f6",
        "server": "e385222cd91994dc",
        "database": "demo",
        "x": 780,
        "y": 400,
        "wires": [
            [
                "f9c4f70dc2d79548"
            ]
        ]
    },
    {
        "id": "ba09b80a40b65780",
        "type": "inject",
        "z": "01ad89bea2c249f6",
        "name": "",
        "props": [
            {
                "p": "payload"
            }
        ],
        "repeat": "",
        "crontab": "",
        "once": false,
        "onceDelay": 0.1,
        "topic": "",
        "payload": "INSERT INTO t VALUES (NOW, 23)",
        "payloadType": "str",
        "x": 490,
        "y": 400,
        "wires": [
            [
                "0ab8aa0c7f1b7522"
            ]
        ]
    },
    {
        "id": "f9c4f70dc2d79548",
        "type": "debug",
        "z": "01ad89bea2c249f6",
        "name": "",
        "active": true,
        "tosidebar": true,
        "console": false,
        "tostatus": false,
        "complete": "payload",
        "targetType": "msg",
        "statusVal": "",
        "statusType": "auto",
        "x": 1050,
        "y": 400,
        "wires": []
    },
    {
        "id": "e385222cd91994dc",
        "type": "taos-config",
        "host": "localhost",
        "port": "6030",
        "username": "root",
        "password": "taosdata"
    }
]
```