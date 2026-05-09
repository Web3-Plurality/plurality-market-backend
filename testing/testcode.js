import React, { useState, useEffect } from 'react';
import axios from 'axios';



const Axios = axios.create({
  baseURL: "https://app.plurality.local/",
  withCredentials: true,
});

function App() {
  const [sseMessage, setSseMessage] = useState('');
  const [isInfoButtonEnabled, setIsInfoButtonEnabled] = useState(false);
  const [popup, setPopup] = useState(null);




  useEffect(() => {
    
    // axios.defaults.withCredentials = true;
    Axios.get('https://app.plurality.local/oauth-twitter/register',{
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Credentials": true,
        "Access-Control-Allow-Origin": true,      
        "Access-Control-Allow-Headers": true, 
        "Access-Control-Allow-Methods": true 
    }
    }).then((res)=>{
    console.log("register")
      setupSSE()
    })
    // Call the /register API to establish SSE connection
    // axios.get('https://app.plurality.local/oauth-twitter/register')
    //   .then(response => {
    //     console.log('Session registered:', response.data);
    //     setupSSE();
    //   })
    //   .catch(error => {
    //     console.error('Error registering session:', error);
    //   });
  }, []);

  const setupSSE = () => {
    const evtSource = new EventSource('https://app.plurality.local/oauth-twitter/register-event');
    evtSource.onmessage = function (event) {
      console.log('Message from server:', event.data);
      setSseMessage(event.data);

      // Enable the button if the message is "received"
      if (event.data.includes('"message":"received"')) {
        setIsInfoButtonEnabled(true);
      }
    };

    evtSource.onerror = function (err) {
      console.error('EventSource failed:', err);
      evtSource.close();
    };
  };

  const handleOAuth = () => {
    const oauthWindow = window.open('https://app.plurality.local/oauth-twitter?isWidget=true&origin=false&apps=false', 'oauth', 'width=500,height=600');
    setPopup(oauthWindow);
  };

  useEffect(() => {
    const checkPopup = setInterval(() => {
      if (popup && popup.closed) {
        console.log('Popup closed');
        setPopup(null);
        clearInterval(checkPopup);
      }
    }, 1000);

    return () => clearInterval(checkPopup);
  }, [popup]);

  const handleInfoRequest = () => {
    axios.get('http://localhost:3000/info')
      .then(response => {
        console.log('Info:', response.data);
      })
      .catch(error => {
        console.error('Error getting info:', error);
      });
  };

  return (
    <div className="App">
      <h1>SSE and OAuth Example</h1>
      <button onClick={handleOAuth}>Start OAuth</button>
      <button onClick={handleInfoRequest} disabled={!isInfoButtonEnabled}>Get Info</button>
      <div>
        <h2>SSE Message:</h2>
        <p>{sseMessage}</p>
      </div>
    </div>
  );
}

export default App;
