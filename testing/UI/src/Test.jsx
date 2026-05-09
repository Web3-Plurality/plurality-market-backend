import axios from 'axios';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';


function Test() {
    const [searchParams] = useSearchParams();
    const accessTokenID = searchParams.get('token_id');



    useEffect(() => {
        if (accessTokenID) {
        
        console.log(accessTokenID)
        console.log(localStorage.getItem('sseUUID')) 
        axios.post(`${process.env.REACT_APP_OAuth_Endpoint}/event`,{},{
            headers: {
            'x-sse-id': localStorage.getItem('sseUUID'),
            'x-token-id':accessTokenID
          }})
        .then(response => {
          console.log('Info:', response.data);
          window.close();
        })
        .catch(error => {
          console.error('Error getting info:', error);
        });
    }
    },[accessTokenID]);

        
    return (  <>
    accessTokenID:
    {accessTokenID}
    </>);
}

export default Test;