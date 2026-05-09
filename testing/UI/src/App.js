import React, { useState, useEffect } from 'react';
import axios from 'axios';
import LitTest from './LitTest';



// const REACT_APP_OAuth_Endpoint = "https://app.plurality.local";
axios.defaults.withCredentials = true;



function App() {
  const [sseMessage, setSseMessage] = useState('');
  const [isInfoButtonEnabled, setIsInfoButtonEnabled] = useState(false);
  const [popup, setPopup] = useState(null);
  const [sseID, setSSEID] = useState("");
  const [tokenID, setTokenID] = useState("null");

  // const handle = ()=>{
  //   axios.get('http://localhost:5000/register').then((res)=>{
  // console.log("register")
  // })
  // }

  // For Google Login
  // useEffect(() => {
  //   const handleMessage = (event: MessageEvent) => {
  //     // if (event.origin !== "https://app.plurality.local") return

  //     if (event.data.type === 'AUTH_SUCCESS') {
  //       localStorage.setItem('token', event.data.pluralityToken);
  //       localStorage.setItem('googleToken', event.data.googleAccessToken);

  //       // getUser();
  //     }

  //     if (event.data.type === "AUTH_ERROR") {
  //       console.error("Authentication failed", event.data)
  //       // setAuthError(event.data.message)
  //     }
  //   }

  //   window.addEventListener("message", handleMessage)

  //   return () => {
  //     window.removeEventListener("message", handleMessage)
  //   }
  // }, [])

  const handleAPI = () => {
    setupSSE()
  }

  const setupSSE = () => {
    const evtSource = new EventSource('https://app.plurality.local/register-event', { withCredentials: true });
    evtSource.onmessage = function (event) {
      console.log('Message from server:', JSON.parse(event?.data)?.message);
      setSseMessage(event.data);
      //set sse id
      setSSEID(JSON.parse(event?.data)?.id);
      // Enable the button if the message is "received"
      if (JSON.parse(event?.data)?.message === "received") {

        console.log(JSON.parse(event?.data))
        //localStorage.setItem('tokenID', JSON.parse(event?.data)?.auth);

        /*if (popup) {
          popup.close();
          setPopup(null);
          console.log('Window closed.');
        } else {
          console.log('No window to close or window already closed.');
        }*/

        // axios.get(`${process.env.REACT_APP_OAuth_Endpoint}/info`,{
        //   headers: {
        //     'x-token-id': JSON.parse(event?.data)?.auth
        //   }
        // })
        //   .then(response => {
        //     console.log('Info:', response.data);
        //   })
        //   .catch(error => {
        //     console.error('Error getting info:', error);
        //   });

        //setIsInfoButtonEnabled(true);
      }
    };

    evtSource.onerror = function (err) {
      console.error('EventSource failed:', err);
      evtSource.close();
    };
  };

  const handleOAuth = () => {
    localStorage.setItem('sseUUID', sseID);
    const oauthWindow = window.open(`${process.env.REACT_APP_OAuth_Endpoint}/login?sse_id=${sseID}`, 'oauth', 'width=500,height=600');
    if (oauthWindow) {
      setPopup(oauthWindow);
      console.log('Window opened:', oauthWindow);
    } else {
      console.error('Failed to open window. It might be blocked by a popup blocker.');
    }


  };


  const handleEvent = async () => {
    const data = await axios.post(`${process.env.REACT_APP_OAuth_Endpoint}/event`, {
      headers: {
        'x-sse-id': sseID,
        "x-token-id": tokenID
      }
    })

  };
  const googleLogin = () => {
    console.log("google login")
    const oauthWindow = window.open(`${'https://app.plurality.local/auth/google/login'}`, 'oauth', 'width=500,height=600');
    if (oauthWindow) {
      setPopup(oauthWindow);
      console.log('Window opened:', oauthWindow);
    } else {
      console.error('Failed to open window. It might be blocked by a popup blocker.');
    }
  }

  const mintPkp = async () => {
    console.log("mint pkp")
    const data = await axios.get(`${process.env.REACT_APP_OAuth_Endpoint}/mint-pkp`)
    console.log(data)
  }


  return (
    <div className="App">
      <h1>SSE and OAuth Example</h1>
      <button onClick={handleOAuth}>Start OAuth</button>
      {/* <button onClick={handleInfoRequest} disabled={!isInfoButtonEnabled}>Get Info</button> */}
      {/* <button onClick={handleEvent} >event</button> */}
      <button onClick={handleAPI} >register event</button>
      <div>
        <h2>SSE Message:</h2>
        <p>{sseMessage}</p>
      </div>
      <div>
        <button onClick={googleLogin}>Login With Google</button>
      </div>
      <div >

        <button onClick={()=>mintPkp()}>mint pkp</button>
      </div>
    </div>
  );
}

export default App;
