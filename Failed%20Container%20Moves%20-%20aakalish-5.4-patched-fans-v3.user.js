// ==UserScript==
// @name         Failed Container Moves - aakalish
// @namespace    Notifications on failed moves for a container
// @version      5.4-fans-v3
// @description  notifications for failed container moves
// @author       @aakalish
// @downloadURL  https://axzile.corp.amazon.com/-/carthamus/download_script/failed-container-moves.user.js
// @updateURL    https://axzile.corp.amazon.com/-/carthamus/download_script/failed-container-moves.user.js
// @match        https://trans-logistics.amazon.com/sortcenter/*
// @match        https://trans-logistics-eu.amazon.com/sortcenter/*
// @match        https://trans-logistics-fe.amazon.com/sortcenter/*
// @exclude      https://trans-logistics-fe.amazon.com/sortcenter/tantei*
// @exclude      https://trans-logistics-eu.amazon.com/sortcenter/tantei*
// @exclude      https://trans-logistics.amazon.com/sortcenter/tantei*
// @grant        GM_addStyle
// @grant        window.focus
// @grant        parent.focus
// @grant        GM_xmlhttpRequest
// @require      https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js
// @connect      fans-iad.amazon.com
// ==/UserScript==
// v0.0 - initial commit
// v1.1 - added onclose function in case user doesnt click
//      - added failed user picture
// v1.2 - allowed for different buildings
// v1.5 - added login to notification
// v1.6 - added last updated check on closed not staged to reduce notification volume
// v1.7 - removed 0 content containers from closed not staged
// v2.0 - added a check for incorrectly created containers
// v2.1 - fixed for CDW5
// v2.2 - added open tt with the container when you click on the notification
// v2.4 - fixed IB stuff for YVR3
// v2.5 - fixed not checking for bad created containers
// v2.6 - added complete CBB script. added dwell time in minutes for closed not staged.
// v2.8 - added looking a TT to make sure failed moves were not corrected.
// v3.0 - added toggles for each functionality. fixed removal of trans
// v4.0 - show table functionality
// v4.2 - remove table on toggle remove
// v4.3 - added for eu
// v4.4 - accidentally missed a ! twice
// v4.5 - changed closed not staged logic to match shift metrics
// v4.6 - removed cases from closed not staged
// v5.1 - removed stuff for eu i guess. added fe
// v5.2 - throttle for TT. also make sure things are closed.
// v5.3 - trying to reduce errors in reporting. like 25% sure it fixed the blank problem
// v5.4 - sym cart
(function() {
    'use strict';

    var country = document.URL.split('-fe').length > 1 ? 'https://trans-logistics-fe.amazon.com/' : (document.URL.split('-eu.').length > 1 ? 'https://trans-logistics-eu.amazon.com/' : 'https://trans-logistics.amazon.com/');

    var data;
    var startNotif = true;
    var token;
    var tanteiToken = '';
    var building;
    var notifications = new NotifyQueue;
    var timerfailed;
    var timernotstaged;
    var timercreatebad;
    var cnots = null;
    var failm = null;
    var cbb = null;
    var ttThrottle = 0;
    var timerthrottle = setInterval(function() { ttThrottle = 0; }, 60000*1);
    
    // --- FANS persistent reminders (associate scanners) ---
    var FANS_NEW_MESSAGE_URL = 'https://fans-iad.amazon.com/api/message/new';
    var fansCfg = {
        enabled: true,
        resendEveryMs: 2 * 60 * 1000,   // repeat every 2 minutes
        maxSends: 20,                  // safety cap per container
        jitterMs: 15 * 1000            // spread bursts
    };
    var unresolvedFailed = {}; // containerId -> record

    // Persist unresolved failures so refreshes don't lose reminder state
    var _UF_LS_KEY = "fcm_unresolvedFailed_v1";
    var _ufSavePending = false;
    function _ufLoad() {
        try {
            var raw = unsafeWindow.localStorage.getItem(_UF_LS_KEY);
            if (!raw) return;
            var obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') unresolvedFailed = obj;
        } catch (e) {
            console.log("UF load failed", e);
        }
    }
    function _ufSaveSoon() {
        if (_ufSavePending) return;
        _ufSavePending = true;
        setTimeout(function(){
            _ufSavePending = false;
            try {
                unsafeWindow.localStorage.setItem(_UF_LS_KEY, JSON.stringify(unresolvedFailed));
            } catch (e) {
                console.log("UF save failed", e);
            }
        }, 500);
    }

    _ufLoad();


    function _fansSend(login, messageText) {
        if (!login || !messageText) return;
        GM_xmlhttpRequest({
            method: "POST",
            url: FANS_NEW_MESSAGE_URL,
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                "Accept": "application/json, text/plain, */*"
            },
            data: JSON.stringify({
                to: login,
                directReports: "",
                messageText: messageText,
                cannedResponses: []
            }),
            onload: function (resp) {
                // console.log('FANS ok', resp.status);
            },
            onerror: function (e) {
                console.log('FANS send failed', e);
            }
        });
    }

    function _fansMsgForFailed(rec) {
        return (
            "FAILED MOVE still open\n" +
            "Container: " + rec.containerId + "\n" +
            (rec.stackingFilter ? ("Filter: " + rec.stackingFilter + "\n") : "") +
            (rec.destination ? ("Dest: " + rec.destination + "\n") : "") +
            (rec.reason ? ("Reason: " + rec.reason + "\n") : "") +
            "Fix the move, then rescan."
        );
    }

    // Periodically resend unresolved failed moves to scanners until corrected (cleared in callTantei).
    setInterval(function () {
        if (!fansCfg.enabled) return;
        var now = Date.now();
        Object.keys(unresolvedFailed).forEach(function (cid) {
            var rec = unresolvedFailed[cid];
            if (!rec || !rec.login) return;
            if (rec.sendCount >= fansCfg.maxSends) return;

            var due = rec.lastSent + fansCfg.resendEveryMs + Math.floor(Math.random() * fansCfg.jitterMs);
            if (now < due) return;

            _fansSend(rec.login, _fansMsgForFailed(rec));
            rec.lastSent = now;
            rec.sendCount++;
                    _ufSaveSoon();
        });
    }, 30 * 1000);
var notSet = {
        cbbToggle: true
        , fcmToggle: true
        , cnsToggle: true
        , tableToggle: true
        , cnsMin: 8
        , getSetToggles: function() {
            if(!!unsafeWindow.localStorage.getItem("cbbToggle"))
            {
                this.cbbToggle = JSON.parse(unsafeWindow.localStorage.getItem("cbbToggle"));
            };
            if(!!unsafeWindow.localStorage.getItem("fcmToggle"))
            {
                this.fcmToggle = JSON.parse(unsafeWindow.localStorage.getItem("fcmToggle"));
            };
            if(!!unsafeWindow.localStorage.getItem("cnsToggle"))
            {
                this.cnsToggle = JSON.parse(unsafeWindow.localStorage.getItem("cnsToggle"));
            };
            if(!!unsafeWindow.localStorage.getItem("tableToggle"))
            {
                this.tableToggle = JSON.parse(unsafeWindow.localStorage.getItem("tableToggle"));
            };
            if(!!unsafeWindow.localStorage.getItem("cnsmin"))
            {
                this.cnsMin = JSON.parse(unsafeWindow.localStorage.getItem("cnsmin"));
            };
            document.getElementById('cbbToggle').checked = this.cbbToggle;
            document.getElementById('fcmToggle').checked = this.fcmToggle;
            document.getElementById('cnsToggle').checked = this.cnsToggle;
            document.getElementById('tableToggle').checked = this.tableToggle;
            document.getElementById('cnsmin').value = this.cnsMin;
            this.setToggles();
        }
        , setToggles: function() {
            unsafeWindow.localStorage.setItem("cbbToggle",this.cbbToggle);
            unsafeWindow.localStorage.setItem("fcmToggle",this.fcmToggle);
            unsafeWindow.localStorage.setItem("cnsToggle",this.cnsToggle);
            unsafeWindow.localStorage.setItem("tableToggle",this.tableToggle);
            unsafeWindow.localStorage.setItem("cnsmin",this.cnsMin);
        }
        , addEvents: function() {
            document.getElementById('cbbToggle').addEventListener('change', function(event) { notSet.cbbToggle = this.checked; notSet.setToggles(); notSet.startUp('cbbToggle'); });
            document.getElementById('fcmToggle').addEventListener('change', function(event) { notSet.fcmToggle = this.checked; notSet.setToggles(); notSet.startUp('fcmToggle'); });
            document.getElementById('cnsToggle').addEventListener('change', function(event) { notSet.cnsToggle = this.checked; notSet.setToggles(); notSet.startUp('cnsToggle'); });
            document.getElementById('tableToggle').addEventListener('change', function(event) { notSet.tableToggle = this.checked; notSet.setToggles(); });
            document.getElementById('cnsmin').addEventListener('change', function(event) { notSet.cnsMin = this.value; notSet.setToggles(); });
        }
        , startUp: function(a) {
            if (unsafeWindow.localStorage.getItem('fcmToggle') == 'true' && (a =='all' || a == 'fcmToggle'))
            {
                console.log('added checked for Failed');
                inceptionFailed();
                timerfailed = setInterval(inceptionFailed, 60000*1);
            } else if (unsafeWindow.localStorage.getItem('fcmToggle') == 'false')
            {
                console.log('removed check for failed');
                timerfailed = null;
                $('#failm').remove();
            }
            if (unsafeWindow.localStorage.getItem('cnsToggle') == 'true' && (a =='all' || a == 'cnsToggle'))
            {
                console.log('added check for closed');
                inceptionNotStaged();
                timernotstaged = setInterval(inceptionNotStaged, 60000*1);
            } else if (unsafeWindow.localStorage.getItem('cnsToggle') == 'false')
            {
                console.log('removed check for closed');
                timernotstaged = null;
                $('#cns').remove();
            }
            if (unsafeWindow.localStorage.getItem('cbbToggle') == 'true' && (a =='all' || a == 'cbbToggle'))
            {
                console.log('adding check for cbb');
                inceptionCreateBad();
                timercreatebad = setInterval(inceptionCreateBad, 60000*5);
            }else if (unsafeWindow.localStorage.getItem('cbbToggle') == 'false')
            {
                console.log('removed check for cbb');
                timercreatebad = null;
                $('#cbb').remove();
            }
        }

    };
    var fmSound = new Audio('http://noproblo.dayjo.org/ZeldaSounds/SSB/SSB_Sword3.wav');

    if (document.readyState != 'complete') {
        window.addEventListener('load', windowLoadedCallback);
    } else {
        windowLoadedCallback();
    }

    GM_addStyle( `
.performance th {
	background: #000000;
	color: white;
	font-weight: bold;
    font-size: 20px;
	}
.performance td, th {
	padding: 10px;
	border: 1px solid #ccc;
	text-align: left;
	font-size: 16px;
	}

.performance {
    background: #c9c6c5;
    border-collapse: collapse;
    overflow-x: scroll;
    width: 50%;
    vertical-align: top;
    }

.performance caption {
    font-size: 28px;
    background: #7393B3;
    color: white;
}

.performance .red {
    background:  #ffcccb;
    }

.Title {text-align: center;}

.performance tr:hover {background-color: #c7dcf0;}

            ` );

    function windowLoadedCallback() {
        document.getElementById('pageContentContainer').insertAdjacentHTML('beforebegin', `
               <div id="dashboard">
                   <div>
                       <span class="myLabel">Create by Barcode</span>
                       <label class="switch">
                           <input id="cbbToggle" type="checkbox">
                           <span class="sliderr round"></span>
                       </label>
                       <span class="myLabel">Failed Container Moves</span>
                       <label class="switch">
                           <input id="fcmToggle" type="checkbox">
                           <span class="sliderr round"></span>
                       </label>
                       <span class="myLabel">Closed Not Staged</span>
                       <label class="switch">
                           <input id="cnsToggle" type="checkbox">
                           <span class="sliderr round"></span>
                       </label>
                       <span class="myLabel">Show in Tables</span>
                       <label class="switch">
                           <input id="tableToggle" type="checkbox">
                           <span class="sliderr round"></span>
                       </label>
                       <span class="myLabel">Min Dwell Time</span>
                       <input id="cnsmin" type=number>
                   </div>
               </div>
          ` );
        notSet.getSetToggles();
        notSet.addEvents();
        GM_addStyle ( `
               /* The switch - the box around the sliderr */
               .switch {
                   position: relative;
                   display: inline-block;
                   width: 60px;
                   height: 34px;
                }
                /* Hide default HTML checkbox */
                .switch input {
                   opacity: 0;
                   width: 0;
                   height: 0;
                }
                /* The sliderr */
                .sliderr {
                   position: absolute;
                   cursor: pointer;
                   top: 0;
                   left: 0;
                   right: 0;
                   bottom: 0;
                   background-color: #ccc;
                   -webkit-transition: .4s;
                   transition: .4s;
                }
                .sliderr:before {
                   position: absolute;
                   content: "";
                   height: 26px;
                   width: 26px;
                   left: 4px;
                   bottom: 4px;
                   background-color: white;
                   -webkit-transition: .4s;
                   transition: .4s;
                }
                input:checked + .sliderr {
                   background-color: #2196F3;
                }
                input:focus + .sliderr {
                   box-shadow: 0 0 1px #2196F3;
                }
                input:checked + .sliderr:before {
                   -webkit-transform: translateX(26px);
                   -ms-transform: translateX(26px);
                   transform: translateX(26px);
                }
                /* Rounded sliderrs */
                .sliderr.round {
                   border-radius: 34px;
                }
                .sliderr.round:before {
                   border-radius: 50%;
                }
                .myLabel {
                   font-size: x-large;
                   vertical-align: top;
                }
                #cnsmin {
                   width: 50px;
                   vertical-align: top;
                }
            ` );
    };

    if (Notification.permission !== "granted") {
        Notification.requestPermission();
    }

    function NotifyQueue(){
        this.currentTask = null;
        this.tasks = [];
        this.history = {};
    }

    NotifyQueue.prototype.addTask = function(obj,notifyType){
        switch( notifyType )
        {
            case 0 :
                failm.add(obj,'failm');
                break;
            case 1:
                cnots.add(obj,'cnots');
                break;
            case 2:
                cbb.add(obj,'cbb');
                break;
            default :
                break;
        };
        if (!this.history.hasOwnProperty(((!!obj.id) ? obj.id : obj.containerId) + obj.cpt))
        {
            this.tasks.push( {obj: obj, type:notifyType} );
            this.history[((!!obj.id) ? obj.id : obj.containerId) + obj.cpt] = true;

            // If there's a scheduled task, bail out.
            if(this.currentTask) return;

            // Otherwise, start kicking tires
            this.launchNextTask();
        };
    };

    NotifyQueue.prototype.launchNextTask = function(){
        var nextTask = this.tasks.pop();

        // There's no more tasks, clean up.
        if(!nextTask) return this.clear();

        //call that
        this.currentTask = nextTask;

        switch( nextTask.type )
        {
            case 0 :
                notifyFailed(nextTask.obj);
                break;
            case 1:
                notifyNotStaged(nextTask.obj);
                break;
            case 2:
                notifyCreateBad(nextTask.obj);
                break;
            default :
                break;
        };


    };

    NotifyQueue.prototype.clear = function(){

        // Timer clears only destroy the timer. It doesn't null references.
        this.currentTask = null;

        // Fast way to clear the task queue
        this.tasks.length = 0;
    };

    function pokemon(){
        //got to catch them all (api calls)
        const constantMock = unsafeWindow.fetch;
        unsafeWindow.fetch = function() {
            intcpt(this,arguments,constantMock);
        }
        const xmlMock = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
            intcpt(this,arguments,xmlMock);
        }

    };
    pokemon();
    function packages(notifyType)
    {
        let prop
        switch( notifyType )
        {
            case 0 :
                prop = 'failm';
                break;
            case 1:
                prop = 'cnots'
                break;
            case 2:
                prop = 'cbb';
                break;
            default :
                break;
        };
        $('#' + prop ).remove();
        this.arr = [];
        this.cptPlusLocation = {};
        this.headers = {};
        if ( prop !== 'cbb' )
        {
            this.headers['Login'] = true;
        };
        this.headers['Stacking Filter'] = true;
        this.headers['Container'] = true;
    };
    packages.prototype.add = function(obj,prop) {
        let objToAdd = {};
        if (obj.userLogin || obj.user )
        {
            objToAdd['Login'] = (!!obj.userLogin) ? obj.userLogin : obj.user;
        };
        objToAdd['Stacking Filter'] = obj.stackingFilter;
        objToAdd['Container'] = (!!obj.id) ? obj.id : obj.containerId;
        if (!!obj.cpt)
        {
            this.headers['CPT'] = true;
            objToAdd['CPT'] = obj.cpt;
        };
        if (!!obj.location)
        {
            this.headers['Location'] = true;
            objToAdd['Location'] = obj.location;
        };
        if (!! obj.reason )
        {
            this.headers['Destination'] = true;
            this.headers['Reason'] = true;
            objToAdd['Destination'] = obj.destination;
            objToAdd['Reason'] = obj.reason;
        }
        else
        {
            this.headers['Packages'] = true;
            objToAdd['Packages'] = obj.childCount;
        };
        if (!! obj.dwell)
        {
            this.headers['Dwell'] = true;
            objToAdd['Dwell'] = obj.dwell;
        };
        this.arr.push(objToAdd);
        if ( notSet.tableToggle )
        {
            createTable(this,prop);
        };
    }
    packages.prototype.getConts = function() {
        return this.arr;
        this.arr = [];
    }
    packages.prototype.getHeaders = function(prop)
    {
        let keys = Object.keys(this.headers)
        return keys;
        this.headers = {};
        if ( prop !== 'cbb' )
        {
            this.headers['Login'] = true;
        };
        this.headers['Stacking Filter'] = true;
        this.headers['Container'] = true;
    };

    function createTable(packages,prop) {
        let propchanger = { 'failm' : 'Failed Container Moves Not Corrected', 'cbb' : 'Create By Barcode Failures', 'cnots' : 'Closed Not Staged' };
        $('#' + prop ).remove();
        let html = '<table id="' + prop + '" class="performance"><caption>' + propchanger[prop] + '</caption>' + getHeaders(packages.getHeaders(prop)) + getBody(packages.getConts(),packages.getHeaders(prop)) + '</table>';
        document.getElementById('pageContentContainer').insertAdjacentHTML('beforebegin', html);
        if ( prop == 'cbb' )
        {
            $('#' + prop).find('tbody').find('tr').click( function() { let url = country + 'sortcenter/tantei?nodeId=' + building + '&searchId=' + this.children[1].innerText;
                                                                      window.open(url, '_blank'); });
        }
        else
        {
            $('#' + prop).find('tbody').find('tr').click( function() { let url = country + 'sortcenter/tantei?nodeId=' + building + '&searchId=' + this.children[2].innerText;
                                                                      window.open(url, '_blank'); });
        };
        function getHeaders(headers)
        {
            let html = '<thead><tr>' + loop(headers) + '</tr></thead>';
            function loop(headers) {
                let html = '';
                for ( let i = 0; i < headers.length; i++ )
                {
                    html += '<th>' + headers[i] + '</th>';
                };
                return html;
            };
            return html;
        };
        function getBody(data,headers)
        {
            let html = '<tbody>';
            for ( let i = 0; i < data.length; i++ )
            {
                let cl = (new Date(data[i].CPT) - new Date() < 30*60*1000) ? ' class="red"' : '';
                data[i].CPT = new Date(data[i].CPT).toLocaleString();
                html += '<tr' + cl + '>';
                for (let j = 0; j < headers.length; j++)
                {
                    if (data[i][headers[j]] == undefined)
                    {
                        data[i][headers[j]] = '';
                    };
                    html += '<td>' + data[i][headers[j]] + '</td>';
                };
                html += '</tr>';
            };
            return html + '</tbody>';
        };

    };

    function intcpt(x,args,mock)
    {
        //intercept the api call
        //do what you want here

        if (startNotif && args[0].split('nti-csrftoken-a2z=').length > 1)
        {
            token = decodeURIComponent(args[0].split('nti-csrftoken-a2z=')[1].split('&json')[0]);
            startNotif = false;
            notSet.startUp('all');
        };
        return mock.apply(x,args);
    };


    function notifyFailed(obj)
    {
        var bodyStr = obj.userLogin+ '\n' + obj.stackingFilter + '\n' + obj.containerId + '\n' + obj.reason + '\n' + obj.destination;
        var notifyIcon = 'https://internal-cdn.amazon.com/badgephotos.amazon.com/?uid=' + obj.userLogin;
        var note;
        note = new Notification('Failed Container Move',
                                {
            body: bodyStr,
            icon: notifyIcon,
            tag: 'fmNotify'});
        note.onclick = function() {
            let url = country + 'sortcenter/tantei?nodeId=' + building + '&searchId=' + this.body.split('\n')[2];
            unsafeWindow.open(url, '_blank');
        };
        note.onclose = function ()
        {
            notifications.launchNextTask();
        };
        //setTimeout(function() {note.close()}, 5000);
        try
        {
            let sounded = fmSound.play();
        } catch (e) { console.log(e);};
    };

    function notifyNotStaged(obj)
    {
        var bodyStr = obj.user + '\n' + obj.stackingFilter + '\n' + obj.id + '\n' + obj.location + '\n Packages: ' + obj.childCount + (!!obj.dwell? ('\n Dwell Time: ' + obj.dwell) : '');
        var notifyIcon = 'https://internal-cdn.amazon.com/badgephotos.amazon.com/?uid=' + obj.user;
        var note;
        note = new Notification('Closed Not Staged',
                                {
            body: bodyStr,
            icon: notifyIcon,
            tag: 'fmNotify'});
        note.onclick = function() {
            let url = country + 'sortcenter/tantei?nodeId=' + building + '&searchId=' + this.body.split('\n')[2];
            window.open(url, '_blank');
        };
        note.onclose = function ()
        {
            notifications.launchNextTask();
        };
        //setTimeout(function() {note.close()}, 5000);
        try
        {
            let sounded = fmSound.play();
        } catch (e) {console.log(e)};
    };

    function notifyCreateBad(obj)
    {
        var bodyStr = obj.user + '\n' + obj.stackingFilter + '\n' + obj.id + '\n' + obj.location + '\n Packages: ' + obj.childCount;
        var notifyIcon = 'https://internal-cdn.amazon.com/badgephotos.amazon.com/?uid=' + obj.user;
        var note;
        note = new Notification('Container Created Incorrectly',
                                {
            body: bodyStr,
            icon: notifyIcon,
            tag: 'fmNotify'});
        note.onclick = function() {
            let url = country + 'sortcenter/tantei?nodeId=' + building + '&searchId=' + this.body.split('\n')[2];
            window.open(url, '_blank');
        };
        note.onclose = function ()
        {
            notifications.launchNextTask();
        };
        //setTimeout(function() {note.close()}, 5000);
        try
        {
            let sounded = fmSound.play();
        } catch (e) {console.log(e)};
    };

    function rdate(dater)
    {
        var interval = 1 * 60 * 1000; // 30 minutes in milliseconds
        return new Date(Math.round(dater.getTime()/interval,0)*interval).getTime();
    };

    function inceptionFailed()
    {
        console.log("Checking for failed moves...");
        var building = null;
        let childs = document.getElementById("availableNodeName").children
        for ( var i = 0; i < childs.length; i++ )
        {
            if (childs[i].selected)
            {
                building = childs[i].id;
            };
        };

        //building = 'CDW5';

        var eT = rdate(new Date());
        var sT = rdate(new Date(new Date()-60000*60*5))
        var poster = {
            jsonObj:'{\"nodeId\":\"' + building + '\",\"nodeType\":\"FC\",\"entity\":\"getQualityMetricDetails\",\"metricType\":\"FAILED_MOVES\",\"containerTypes\":[\"PALLET\",\"GAYLORD\",\"BAG\",\"CART\"],\"startTime\":'+ sT +',\"endTime\":' + eT +',\"metricsData\":{\"nodeId\":\"' + building + '\",\"pageType\":\"OUTBOUND\",\"refreshType\":\"\",\"device\":\"DESKTOP\",\"nodeType\":\"FC\",\"userAction\":\"FAILED_MOVES_SUBMIT_CLICK\"}}'
        }
        //console.log('https://trans-logistics.amazon.com/sortcenter/vista/controller/getQualityMetricDetails?'+new URLSearchParams(poster).toString());


        GM_xmlhttpRequest({
            method: "GET",
            url: country + 'sortcenter/vista/controller/getQualityMetricDetails?'+new URLSearchParams(poster).toString(),
            rheaders: {
                "Accept" :"*/*",
                "anti-csrftoken-a2z" :	token,
                "content-type" : "application/x-www-form-urlencoded",
                "Cookie" : document.cookie
            },
            onload: function (response) {
                let data = response.responseText;
                data = ( typeof data === 'object' ) ? data : JSON.parse(data);

                failm = new packages(0);
                var failedmoves = data.ret.getQualityMetricDetailsOutput.qualityMetrics

                for ( var i = 0; i < failedmoves.length; i++ )
                {

                    //notifHistory[failedmoves[i].containerId + failedmoves[i].time] = failedmoves[i];
                    //notifications.addTask(failedmoves[i],0);
                    apiCall(failedmoves[i],0);

                };
            }
        });
    };
    function inceptionNotStaged()
    {
        console.log("Checking for closed not staged...");
        building = null;
        let childs = document.getElementById("availableNodeName").children
        for ( var i = 0; i < childs.length; i++ )
        {
            if (childs[i].selected)
            {
                building = childs[i].id;
            };
        };

        //building = 'CDW5';
        var eT = rdate(new Date());
        var sT = rdate(new Date(new Date()-60000*60*23))

        var poster = {
            jsonObj : '{\"entity\":\"getContainersDetailByCriteria\",\"nodeId\":\"' + building + '\",\"timeBucket\":{\"fieldName\":\"physicalLocationMoveTimestamp\",\"startTime\":' + sT + ',\"endTime\":' + eT + '},\"filterBy\":{\"state\":[\"Stacked\"],\"isMissing\":[false],\"isClosed\":[true]},\"containerTypes\":[\"PALLET\",\"GAYLORD\",\"BAG\",\"CART\"],\"fetchCompoundContainerDetails\":true,\"includeCriticalCptEnclosingContainers\":false}'
        };

        GM_xmlhttpRequest({
            method: "GET",
            url: country + 'sortcenter/vista/controller/getContainersDetailByCriteria?'+new URLSearchParams(poster).toString(),
            rheaders: {
                "Accept" :"*/*",
                "anti-csrftoken-a2z" :	token,
                "content-type" : "application/x-www-form-urlencoded",
                "Cookie" : document.cookie
            },
            onload: function (response) {
                let data = response.responseText;
                data = ( typeof data === 'object' ) ? data : JSON.parse(data);
                cnots = new packages(1);
                if(  !!data.ret.getContainersDetailByCriteriaOutput )
                {
                    var failedmoves = data.ret.getContainersDetailByCriteriaOutput.containerDetails[0].containerDetails;

                    for ( var i = 0; i < failedmoves.length; i++ )
                    {
                        if (!failedmoves[i].stackingFilter && failedmoves[i].location.split('TRANS').length == 1 && failedmoves[i].childCount > 0 && !(failedmoves[i].locationType == 'GENERAL_AREA') && !(failedmoves[i].location.substring(0,2) == 'XD') && !(failedmoves[i].location.split('IB').length > 1))
                        {
                            apiCall(failedmoves[i],1);
                        }
                        else
                        {
                            if (!!failedmoves[i].stackingFilter )
                            {
                                if (failedmoves[i].location.split('TRANS').length == 1 && failedmoves[i].stackingFilter.split('TOTE').length + failedmoves[i].stackingFilter.split('LIQ').length + failedmoves[i].stackingFilter.split('CASE').length + failedmoves[i].stackingFilter.split('REAC').length + failedmoves[i].stackingFilter.split('SLOW').length== 5 && failedmoves[i].childCount > 0 && !(failedmoves[i].locationType == 'GENERAL_AREA') && !(failedmoves[i].location.substring(0,2) == 'XD') && !(failedmoves[i].location.split('IB').length > 1) && !(failedmoves[i].stackingFilter.split('DON').length > 1))
                                {
                                    apiCall(failedmoves[i],1);
                                };
                            };
                        };
                    };
                };
            }
        });
    };

    function inceptionCreateBad()
    {
        console.log("Checking for create bad...");
        building = null;
        let childs = document.getElementById("availableNodeName").children
        for ( var i = 0; i < childs.length; i++ )
        {
            if (childs[i].selected)
            {
                building = childs[i].id;
            };
        };
        //building = 'CDW5';
        var eT = rdate(new Date());
        var sT = rdate(new Date(new Date()-60000*60*5))

        var poster = {
            jsonObj : '{\"entity\":\"getContainersDetailByCriteria\",\"nodeId\":\"' + building + '\",\"timeBucket\":{\"fieldName\":\"physicalLocationMoveTimestamp\",\"startTime\":' + sT + ',\"endTime\":' + eT + '},\"filterBy\":{\"state\":[\"Stacked\"],\"isMissing\":[false],\"isClosed\":[false]},\"containerTypes\":[\"PALLET\",\"GAYLORD\",\"BAG\",\"CART\"],\"fetchCompoundContainerDetails\":true,\"includeCriticalCptEnclosingContainers\":false}'
        };

        GM_xmlhttpRequest({
            method: "GET",
            url: country + 'sortcenter/vista/controller/getContainersDetailByCriteria?'+new URLSearchParams(poster).toString(),
            rheaders: {
                "Accept" :"*/*",
                "anti-csrftoken-a2z" :	token,
                "content-type" : "application/x-www-form-urlencoded",
                "Cookie" : document.cookie
            },
            onload: function (response) {
                let data = response.responseText;
                data = ( typeof data === 'object' ) ? data : JSON.parse(data);

                cbb = new packages(2);
                if ( !!data.ret.getContainersDetailByCriteriaOutput )
                {
                    var failedmoves = data.ret.getContainersDetailByCriteriaOutput.containerDetails[0].containerDetails;

                    for ( var i = 0; i < failedmoves.length; i++ )
                    {
                        let crit = false;
                        crit = crit || failedmoves[i].id.substring(0,3) == 'BAG';
                        crit = crit || failedmoves[i].id.substring(0,4) == 'CART';
                        crit = crit || failedmoves[i].id.substring(0,6) == 'PALLET';
                        crit = crit || failedmoves[i].id.substring(0,7) == 'GAYLORD';
                        crit = crit || failedmoves[i].id.substring(0,2) == 'pb';
                        crit = crit || (failedmoves[i].id.substring(0,1) == 'a' && Number(failedmoves[i].id.substring(1)) > 0);
                        //crit = crit || !(failedmoves[i].stackingFilter.split('CART-').length > 1 && !failedmoves[i].id.substring(0,4) == 'CART')
                        if (!!failedmoves[i].stackingFilter)
                        {
                            if (failedmoves[i].childCount > 0 && ((failedmoves[i].stackingFilter.split('CART-').length > 1 && !(failedmoves[i].id.substring(0,4) == 'CART') && !(failedmoves[i].id.substring(0,1) == 'a')) || !crit))
                            {
                                //notifHistory[failedmoves[i].containerId + failedmoves[i].cpt] = failedmoves[i];
                                notifications.addTask(failedmoves[i], 2);
                                //apiCall(failedmoves[i],2);
                            };
                        };
                    };
                };
            }
        });
    };

    function callTantei(item,num)
    {
        try
        {
            let poster =
                {
                    "query":"\nquery ($queryInput: [SearchTermInput!]!) {\n  searchEntities(searchTerms: $queryInput) {\n    searchTerm {\n      nodeId\n      nodeTimezone\n      searchId\n      searchIdType\n      resolvedIdType\n    }\n    events {\n      identifier\n      description {\n        ... on AuditAttemptEventDescription {\n          auditStatus\n          userProvidedValue\n          actualValue\n        }\n        ... on ContainerMoveFailureEventDescription {\n          failureReason\n          attemptLocationId\n          attemptLocationLabel\n          attemptDestinationId\n          attemptDestinationLabel\n        }\n        ... on ContainerAssociationEventDescription {\n          associationReason\n          childContainerId\n          childContainerLabel\n          parentContainerId\n          parentContainerLabel\n          parentContainerType\n        }\n        ... on ContainerAuditEventDescription {\n          stateChangeReason\n          currentStateId\n          currentStateScannables\n          currentStateParentId\n          currentStateParentLabel\n          previousStateHasDeparted\n          previousStateLocationId\n          previousStateLocationLabel\n          previousStateParentId\n          previousStateParentLabel\n        }\n        ... on LoadPlanUpdateEventDescription {\n          currentAssociatedTrailerId\n          currentLoadState\n          currentOperationType\n          previousAssociatedTrailerId\n          previousLoadState\n        }\n      }\n      byUser\n      lastUpdateTime\n    }\n  }\n}\n",
                    "variables":{"queryInput":[]}
                }

            poster.variables.queryInput.push({"nodeId": building, "searchId" : item.containerId, "searchIdType" : "UNKNOWN"});
            let url2 = country + "sortcenter/tantei/graphql"
            GM_xmlhttpRequest({
                method: "POST",
                url: url2,
                data: JSON.stringify(poster),
                headers: {
                    "Accept" :"*/*",
                    "anti-csrftoken-a2z" :	token,
                    "content-type" : "application/json"
                },
                onload: function (response) {
                    try
                    {
                        let data = response.responseText;
                        data = ( typeof data === 'object' ) ? data : JSON.parse(data);
                        data.data.searchEntities[0].events.sort( function(a,b) { if (new Date(a.lastUpdateTime) < new Date(b.lastUpdateTime) ) { return -1 } else { return 1; } } );
                        let lastUpdatedAt = data.data.searchEntities[0].events[0].lastUpdateTime;
                        let lastEvent = data.data.searchEntities[0].events[0];
                        let isClosed = false || data.data.searchEntities[0].events[0].description.stateChangeReason == 'CLOSE';

                        for (let i = 0; i < data.data.searchEntities[0].events.length; i++ )
                        {
                            if( !lastEvent.byUser || (lastUpdatedAt < data.data.searchEntities[0].events[i].lastUpdateTime && ((num == 0 && !!data.data.searchEntities[0].events[i].byUser && data.data.searchEntities[0].events[i].description.stateChangeReason == 'CONTAINER_MOVE' || data.data.searchEntities[0].events[i].description.stateChangeReason == 'DEPART') || num!=0 ) ) )
                            {
                                lastUpdatedAt = data.data.searchEntities[0].events[i].lastUpdateTime;
                                lastEvent = data.data.searchEntities[0].events[i];
                            };

                            isClosed = data.data.searchEntities[0].events[i].description.stateChangeReason == 'CLOSE' || isClosed;
                        }

                        
                        // --- Failed move persistence + scanner reminders ---
                        var cid = item.containerId || item.id;
                        var isFailedMove = (num == 0 && lastEvent.description && lastEvent.description.hasOwnProperty('failureReason'));
                        var nowMs = Date.now();

                        if (isFailedMove)
                        {
                            var login = item.userLogin || lastEvent.byUser;
                            if (!unresolvedFailed[cid])
                            {
                                unresolvedFailed[cid] = {
                                    containerId: cid,
                                    login: login,
                                    stackingFilter: item.stackingFilter,
                                    destination: item.destination,
                                    reason: item.reason,
                                    firstSeen: nowMs,
                                    lastSeen: nowMs,
                                    lastSent: 0,
                                    sendCount: 0
                                };
                            }
                            else
                            {
                                unresolvedFailed[cid].login = login || unresolvedFailed[cid].login;
                                unresolvedFailed[cid].stackingFilter = item.stackingFilter || unresolvedFailed[cid].stackingFilter;
                                unresolvedFailed[cid].destination = item.destination || unresolvedFailed[cid].destination;
                                unresolvedFailed[cid].reason = item.reason || unresolvedFailed[cid].reason;
                                unresolvedFailed[cid].lastSeen = nowMs;
                            }
                            _ufSaveSoon();

                            // keep existing desktop notification behavior (deduped by NotifyQueue.history)
                            let timediff = String(Math.round((new Date() - lastUpdatedAt)/60000)) + ' minutes';
                            let touchedBy = lastEvent.byUser;
                            item['user'] = touchedBy;
                            item['dwell'] = timediff;
                            notifications.addTask(item, num);
                        }
                        else if (num == 0 && !!unresolvedFailed[cid])
                        {
                            // corrected: stop repeating on scanners
                            delete unresolvedFailed[cid];
                        }

                        // Existing closed-not-staged check (num != 0) remains unchanged
                        if (lastUpdatedAt < new Date() - 60000 * 8 && num != 0 && lastEvent.description.currentStateParentId == null && lastEvent.description.stateChangeReason !== 'CONTAINER_MOVE')
                        {
                            let timediff = String(Math.round((new Date() - lastUpdatedAt)/60000)) + ' minutes';
                            let touchedBy = lastEvent.byUser;
                            item['user'] = touchedBy;
                            item['dwell'] = timediff;
                            notifications.addTask(item, num);
                        };

                    }
                    catch (e)
                    {
                        console.log(e,data);
                        //notifications.addTask(item, num);
                    };
                }
            });
        } catch(e)
        {
            console.log(e)
            notifications.addTask(item, num);
        };
    };

    function apiCall(item,num)
    {
        ttThrottle ++;
        if( ttThrottle < 30 )
        {
            var url2 = country + "sortcenter/tantei"
            if (tanteiToken == '')
            {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url2,
                    onload: function (response) {
                        const placeholder = document.createElement('div');
                        placeholder.innerHTML = response.responseText;
                        // try to discover anti-csrf token from the Tantei landing page (markup has changed over time)
                        var inp = placeholder.querySelector('input');
                        if (inp && inp.value) {
                            token = inp.value;
                        } else {
                            // fallback: look for anti-csrftoken-a2z pattern in HTML/JS
                            var m = response.responseText && response.responseText.match(/anti-csrftoken-a2z[^\w-]*([A-Za-z0-9%_\-]+)/i);
                            if (m && m[1]) token = m[1];
                            if (!token) {
                                // fallback: try cookie (if accessible)
                                try {
                                    var cm = document.cookie.match(/(?:^|;\s*)nti-csrftoken-a2z=([^;]+)/);
                                    if (cm && cm[1]) token = decodeURIComponent(cm[1]);
                                } catch (e) {}
                            }
                        }
                        callTantei(item,num)
                    }
                });
            }
            else
            {
                callTantei(item,num);
            };
        };
    };

})();
